/**
 * 録画チャンクの逐次永続化 (IndexedDB)。
 *
 * MediaRecorder のチャンクはこれまでメモリ上の配列にしか積まれておらず、
 * ブラウザ/タブがクラッシュすると収録が丸ごと消えていた。recorder.onerror 経由の
 * 確定処理はプロセスが生きている場合しか働かないため、プロセスごと落ちる事故には
 * 無力である。ここでは chunk を受け取るたびに IndexedDB へ書き、次回起動時に
 * 「未確定のまま残っているセッション」を検出して復旧できるようにする。
 *
 * 設計方針:
 * - **録画を止めない**。書き込みに失敗しても例外は投げず、以後の書き込みを諦めて
 *   フラグを立てるだけにする。メモリ上のチャンク配列が引き続き正本であり、
 *   IndexedDB はあくまで保険。
 * - 書き込みは1本のキューに直列化する。ondataavailable は 1 秒に 1 回なので
 *   スループットは問題にならず、順序保証とトランザクション競合回避を優先する。
 * - 正常に保存できたセッションは即座に削除する。ディスクを二重に食い続けない。
 */

const DB_NAME = 'jishushitsu-recording';
const DB_VERSION = 1;
const STORE_SESSIONS = 'sessions';
const STORE_CHUNKS = 'chunks';

/** チャンクキーの上限 (IDBKeyRange.bound 用。Infinity は有効なキーではない) */
const MAX_SEQ = Number.MAX_SAFE_INTEGER;

export interface RecordingSessionMeta {
  id: string;
  /** 録画開始時刻 (epoch ms)。復旧ファイルの名前に使う */
  startedAt: number;
  /** 最後にチャンクを書いた時刻 (epoch ms)。おおよその録画長の算出に使う */
  updatedAt: number;
  mimeType: string;
  filePrefix: string;
  chunkCount: number;
  bytes: number;
  /**
   * 'recording' = 未確定。プロセスが落ちたまま残っていれば復旧対象。
   * 正常に保存できたセッションはレコードごと削除するので 'finalized' は
   * 「保存済みだが後片付けの途中で落ちた」痕跡としてのみ現れる。
   */
  status: 'recording' | 'finalized';
}

export function isRecordingStoreAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isRecordingStoreAvailable()) {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        // [sessionId, seq] の複合キー。seq 昇順で読めば録画順に復元できる。
        db.createObjectStore(STORE_CHUNKS, { keyPath: ['sessionId', 'seq'] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function promisifyTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function requestResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * 1回の録画に対応する書き込みハンドル。
 * すべてのメソッドは失敗しても throw せず、録画本体を巻き込まない。
 */
export class RecordingChunkWriter {
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private disabled = false;
  private meta: RecordingSessionMeta;

  private constructor(
    private db: IDBDatabase,
    meta: RecordingSessionMeta,
    private onFailure: (err: unknown) => void
  ) {
    this.meta = meta;
  }

  get sessionId(): string {
    return this.meta.id;
  }

  /** 永続化が効いているか。false のとき、クラッシュすると復旧できない。 */
  get active(): boolean {
    return !this.disabled;
  }

  /**
   * 録画セッションを開始する。IndexedDB が使えない場合は null を返す
   * (呼び出し側は永続化なしで録画を続ける)。
   */
  static async begin(
    params: { mimeType: string; filePrefix: string; startedAt: number },
    onFailure: (err: unknown) => void = () => {}
  ): Promise<RecordingChunkWriter | null> {
    try {
      const db = await openDb();
      const meta: RecordingSessionMeta = {
        id: `${params.startedAt}-${Math.random().toString(36).slice(2, 8)}`,
        startedAt: params.startedAt,
        updatedAt: params.startedAt,
        mimeType: params.mimeType,
        filePrefix: params.filePrefix,
        chunkCount: 0,
        bytes: 0,
        status: 'recording',
      };
      const tx = db.transaction(STORE_SESSIONS, 'readwrite');
      tx.objectStore(STORE_SESSIONS).put(meta);
      await promisifyTx(tx);
      return new RecordingChunkWriter(db, meta, onFailure);
    } catch (err) {
      onFailure(err);
      return null;
    }
  }

  /**
   * チャンクを1つ永続化する。呼び出し側は await しない (録画スレッドを待たせない)。
   * 失敗した時点で以後の書き込みを止める — 容量超過などで毎秒エラーを出し続けても
   * 復旧できる見込みは無く、ログとメインスレッドを浪費するだけだから。
   */
  append(blob: Blob): void {
    if (this.disabled) return;
    const seq = this.seq++;
    this.queue = this.queue
      .then(async () => {
        if (this.disabled) return;
        const tx = this.db.transaction([STORE_CHUNKS, STORE_SESSIONS], 'readwrite');
        tx.objectStore(STORE_CHUNKS).put({ sessionId: this.meta.id, seq, blob });
        this.meta = {
          ...this.meta,
          chunkCount: seq + 1,
          bytes: this.meta.bytes + blob.size,
          updatedAt: Date.now(),
        };
        tx.objectStore(STORE_SESSIONS).put(this.meta);
        await promisifyTx(tx);
      })
      .catch((err) => {
        if (this.disabled) return;
        this.disabled = true;
        this.onFailure(err);
      });
  }

  /** 書き込みキューが片付くまで待つ。 */
  async flush(): Promise<void> {
    try {
      await this.queue;
    } catch {
      // append 側で握り潰し済み
    }
  }

  /**
   * 保存が完了したのでバックアップを破棄する。
   * ここが失敗しても実害は「次回起動時に復旧を促される」だけなので握り潰す。
   */
  async discard(): Promise<void> {
    this.disabled = true;
    try {
      await this.queue;
    } catch {
      // ignore
    }
    try {
      await deleteRecordingSession(this.meta.id, this.db);
    } catch {
      // ignore
    }
  }
}

/** 未確定のまま残っている録画 (= 前回クラッシュした録画) を新しい順に返す。 */
export async function listUnfinishedSessions(): Promise<RecordingSessionMeta[]> {
  if (!isRecordingStoreAvailable()) return [];
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_SESSIONS, 'readonly');
    const all = await requestResult<RecordingSessionMeta[]>(
      tx.objectStore(STORE_SESSIONS).getAll() as IDBRequest<RecordingSessionMeta[]>
    );
    return all
      .filter((s) => s.status === 'recording' && s.chunkCount > 0)
      .sort((a, b) => b.startedAt - a.startedAt);
  } catch {
    return [];
  }
}

/** 保存済みチャンクを録画順に連結して1つの Blob にする。 */
export async function assembleRecording(sessionId: string): Promise<Blob | null> {
  if (!isRecordingStoreAvailable()) return null;
  const db = await openDb();
  const tx = db.transaction([STORE_SESSIONS, STORE_CHUNKS], 'readonly');
  const meta = await requestResult<RecordingSessionMeta | undefined>(
    tx.objectStore(STORE_SESSIONS).get(sessionId) as IDBRequest<RecordingSessionMeta | undefined>
  );
  if (!meta) return null;
  const rows = await requestResult<{ sessionId: string; seq: number; blob: Blob }[]>(
    tx.objectStore(STORE_CHUNKS).getAll(
      IDBKeyRange.bound([sessionId, 0], [sessionId, MAX_SEQ])
    ) as IDBRequest<{ sessionId: string; seq: number; blob: Blob }[]>
  );
  if (rows.length === 0) return null;
  // getAll はキー順に返るが、復元順は正しさの要なので明示的に並べ替える。
  rows.sort((a, b) => a.seq - b.seq);
  return new Blob(
    rows.map((r) => r.blob),
    { type: meta.mimeType }
  );
}

/** セッションとそのチャンクを完全に削除する。 */
export async function deleteRecordingSession(
  sessionId: string,
  existingDb?: IDBDatabase
): Promise<void> {
  if (!isRecordingStoreAvailable()) return;
  const db = existingDb ?? (await openDb());
  const tx = db.transaction([STORE_SESSIONS, STORE_CHUNKS], 'readwrite');
  tx.objectStore(STORE_SESSIONS).delete(sessionId);
  tx.objectStore(STORE_CHUNKS).delete(IDBKeyRange.bound([sessionId, 0], [sessionId, MAX_SEQ]));
  await promisifyTx(tx);
}

/**
 * 古い残骸を掃除する。復旧を促したのに放置されたデータがディスクを
 * 食い続けないよう、既定で 30 日を過ぎた未確定セッションは捨てる。
 */
export async function pruneOldSessions(maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<void> {
  if (!isRecordingStoreAvailable()) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_SESSIONS, 'readonly');
    const all = await requestResult<RecordingSessionMeta[]>(
      tx.objectStore(STORE_SESSIONS).getAll() as IDBRequest<RecordingSessionMeta[]>
    );
    const cutoff = Date.now() - maxAgeMs;
    for (const s of all) {
      if (s.updatedAt < cutoff || s.chunkCount === 0) {
        await deleteRecordingSession(s.id, db).catch(() => {});
      }
    }
  } catch {
    // 掃除の失敗は無視してよい
  }
}

/** 保存中の録画がどれくらいディスクを使えるか調べる (容量警告用)。 */
export async function estimateStorageHeadroom(): Promise<{ usage: number; quota: number } | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est || est.quota == null || est.usage == null) return null;
    return { usage: est.usage, quota: est.quota };
  } catch {
    return null;
  }
}

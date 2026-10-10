/**
 * 講師が参加者を退出させるときの確認と API 呼び出し (InstructorDashboard / ParticipantGrid 共通)。
 *
 * 招待リンクのゲストは同じリンクで入り直せるため、退出だけだとすぐ戻ってこられる。
 * ゲストのときはリンクも無効にするかを続けて確認する。
 * キャンセルされたら null、送信したら Response を返す。
 */
export async function confirmAndRemoveParticipant(
  participantIdentity: string,
  participantName: string,
  roomName: string
): Promise<Response | null> {
  if (!confirm(`${participantName}さんを退出させますか？`)) return null;
  const isGuest = participantIdentity.startsWith('guest:');
  const revokeInvite =
    isGuest &&
    confirm(
      `${participantName}さんの招待リンクも無効にしますか？\n\n` +
        'OK: 同じリンクでは入り直せなくなります\n' +
        'キャンセル: 退出のみ (同じリンクで入り直せます)'
    );
  return fetch('/api/remove-participant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomName, participantIdentity, revokeInvite }),
  });
}

'use client';

// 実コンポーネントを通信・マイクなしで検証する開発専用プレビュー。
import { useState } from 'react';
import { notFound } from 'next/navigation';
import { RoomContext } from '@livekit/components-react';
import { RemoteParticipant, Room, RoomEvent } from 'livekit-client';
import { StudioStage } from '@/components/StudioStage';
import { StudioBar } from '@/components/StudioBar';
import type { StudioLayout } from '@/lib/studio-layouts';
import type { AiTileState } from '@/lib/studio-participants';

const ai: AiTileState = {
  info: { id: 'preview-ai', displayName: 'ChatGPT', avatar: '🤖' },
  visualState: 'idle',
  getLevel: () => 0,
};
const noop = () => {};

export default function SpotlightPreview() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <Preview />;
}

function Preview() {
  const [room] = useState(() => {
    const room = new Room();
    room.localParticipant.identity = 'host';
    room.localParticipant.name = 'ホスト';
    for (const [identity, name] of [['guest', 'ゲスト'], ['audience', '参加者']]) {
      room.remoteParticipants.set(identity, new RemoteParticipant({} as never, identity, identity, name));
    }
    return room;
  });
  const [layout, setLayout] = useState<StudioLayout>('spotlight-strip');
  const [slots, setSlots] = useState<(string | null)[]>(['host', 'guest', null]);
  const [names, setNames] = useState(true);
  const [viewer, setViewer] = useState(false);
  const changeSlot = (index: number, token: string | null) => setSlots((prev) => prev.map((v, i) => i === index ? token : v));
  return (
    <RoomContext.Provider value={room}>
      <div className="relative h-dvh bg-black">
        <StudioStage layout={layout} slotTokens={slots} showNameplates={names}
          aiTiles={{ 'preview-ai': ai }} aiOrb={ai}
          onSpotlight={viewer ? undefined : (token) => changeSlot(0, token)} />
        <div className="absolute top-0 left-0 z-20 flex gap-2 bg-stone-900 p-2 text-white">
          <button onClick={() => setViewer((v) => !v)}>受信側切替</button>
          <button onClick={() => {
            const guest = room.remoteParticipants.get('guest');
            if (guest) {
              room.remoteParticipants.delete('guest');
              room.emit(RoomEvent.ParticipantDisconnected, guest);
            }
          }}>ゲスト退出</button>
        </div>
        {!viewer && <StudioBar isMicOn={false} isCameraOn={false} isScreenSharing={false}
          isLocalRecording={false} recordingQuality="standard" layout={layout} slotIdentities={slots}
          participantOptions={[
            { token: 'host', name: 'ホスト' }, { token: 'guest', name: 'ゲスト' },
            { token: 'audience', name: '参加者' }, { token: 'ai:preview-ai', name: 'ChatGPT' },
          ]}
          showNameplates={names} showAudience={false} chatOpen={false} chatUnreadCount={0}
          onToggleChat={noop} onToggleMic={noop} onToggleCamera={noop} onToggleScreenShare={noop}
          onToggleLocalRecording={noop} onChangeRecordingQuality={noop} onChangeLayout={setLayout}
          onChangeSlot={changeSlot} onToggleNameplates={() => setNames((v) => !v)}
          onToggleAudience={noop} onExitStudio={noop} />}
      </div>
    </RoomContext.Provider>
  );
}

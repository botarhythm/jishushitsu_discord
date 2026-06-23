# Multi-Agent Knowledge

## Breakout Room UX

- Instructor dashboard BO buttons move only the selected participant.
- Instructors stay in the main room after sending a participant to a BO room.
- The right instructor dashboard also has "講師の移動" self-move controls; these move only the current instructor between BO rooms and the main room.
- Participants can return to the main room voluntarily with the control bar "メインに戻る" button.
- Room changes update the local LiveKit metadata `currentRoom` before reconnecting; `/api/rooms-status` filters out stale room connections whose metadata points to another room.
- Instructor room status refreshes immediately on LiveKit participant connect/disconnect/metadata-change events, with polling as a fallback.
- Instructors can move BO participants back to main or remove them from the right dashboard.
- The right dashboard has "全員をメインへ招集" to send all BO occupants a main-room move command.
- There is no instructor-side "終了してメインへ" action that ends a BO room; all-main summon only moves occupants.
- `components/RoomView.tsx` keys `LiveKitRoom` by `currentRoom` so room changes remount the LiveKit connection.

## Deployment

- Deployment is GitHub auto-deploy from `main`.
- Push commits to `origin/main`; Vercel is linked to project `jishushitsu-discord`.
- Run `npx tsc --noEmit` and `npm run build` before pushing when possible.
- Local `npm run build` may need network access because `next/font/google` fetches Inter and Noto Sans JP during the build.

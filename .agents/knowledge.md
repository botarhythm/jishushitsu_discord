# Multi-Agent Knowledge

## Breakout Room UX

- Instructor dashboard BO buttons move only the selected participant.
- Instructors stay in the main room after sending a participant to a BO room.
- The right instructor dashboard also has "講師の移動" self-move controls; these move only the current instructor between BO rooms and the main room.
- Participants can return to the main room voluntarily with the control bar "メインに戻る" button.
- There is no instructor-side "終了してメインへ" action that returns everyone from a BO room.
- `components/RoomView.tsx` keys `LiveKitRoom` by `currentRoom` so room changes remount the LiveKit connection.

## Deployment

- Deployment is GitHub auto-deploy from `main`.
- Push commits to `origin/main`; Vercel is linked to project `jishushitsu-discord`.
- Run `npx tsc --noEmit` and `npm run build` before pushing when possible.
- Local `npm run build` may need network access because `next/font/google` fetches Inter and Noto Sans JP during the build.

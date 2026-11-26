# TRENDORA mobile (Expo)

Consumer app: vertical feed (muted, never autoplays audio), likes, challenge arena with live
leaderboard, rewards and coupon codes. Uses the same `/v1` API and design tokens as the web app.

Installed separately from the pnpm workspace because the Expo toolchain pins its own React Native
version:

```bash
cd apps/mobile
npm install           # or: npx expo install --fix
npx expo start        # set expo.extra.apiUrl in app.json to your LAN URL for devices
npm run typecheck
```

Status: source complete for P0–P5 consumer flows; not yet device-tested in CI (no simulator in the
build environment). Upload/checkout deep-link to the web flows for now.

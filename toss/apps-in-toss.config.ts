import { defineConfig } from "@apps-in-toss/web-framework/config";

// appName 은 앱인토스 콘솔에 등록한 앱 이름(영문 ID)과 똑같아야 업로드돼요.
export default defineConfig({
  appName: "bbaegi",
  permissions: [{ name: "geolocation", access: "access" }],
  navigationBar: { withBackButton: true, withHomeButton: true, withTitle: true },
  webView: { allowsInlineMediaPlayback: true, mediaPlaybackRequiresUserAction: false, bounces: false },
  webBundleDir: "dist",
});

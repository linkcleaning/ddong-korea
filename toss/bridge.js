// 토스 기능(위치·바깥 링크 열기)을 window.__AIT__ 로 넘겨 주는 작은 다리.
// 기존 js/app.js 는 그대로 두고, __AIT__ 가 있으면 토스 방식으로 동작해요.
import { Device, Accuracy } from "@apps-in-toss/web-framework";

window.__AIT__ = {
  getLocation: () => Device.getLocation({ accuracy: Accuracy.High }).then((l) => l.coords),
  openURL: (url) => Device.openURL(url),
};

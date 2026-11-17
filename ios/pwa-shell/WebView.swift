import UIKit
import WebKit
import AuthenticationServices
import SafariServices
import CoreLocation


func createWebView(container: UIView, WKSMH: WKScriptMessageHandler, WKND: WKNavigationDelegate, NSO: NSObject, VC: ViewController) -> WKWebView{

    let config = WKWebViewConfiguration()
    let userContentController = WKUserContentController()

    userContentController.add(WKSMH, name: "print")
    userContentController.add(WKSMH, name: "review") // 별점 요청 (애플 기본 별점 창)
    userContentController.add(WKSMH, name: "push-subscribe")
    userContentController.add(WKSMH, name: "push-permission-request")
    userContentController.add(WKSMH, name: "push-permission-state")
    userContentController.add(WKSMH, name: "push-token")
    // 위치: 앱(아이폰)이 직접 받아서 웹에 넘겨줘요 → 처음 한 번만 물어봐요
    userContentController.add(GeoBridge.shared, name: "geo")
    userContentController.addUserScript(WKUserScript(source: GeoBridge.polyfill, injectionTime: .atDocumentStart, forMainFrameOnly: true))

    config.userContentController = userContentController

    config.limitsNavigationsToAppBoundDomains = true;
    config.allowsInlineMediaPlayback = true
    config.preferences.javaScriptCanOpenWindowsAutomatically = true
    config.preferences.setValue(true, forKey: "standalone")
    
    let webView = WKWebView(frame: calcWebviewFrame(webviewView: container, toolbarView: nil), configuration: config)
    
    setCustomCookie(webView: webView)

    webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]

    webView.isHidden = true;

    webView.navigationDelegate = WKND
    GeoBridge.shared.webView = webView

    webView.scrollView.bounces = false
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.allowsBackForwardNavigationGestures = true
    
    let deviceModel = UIDevice.current.model
    let osVersion = UIDevice.current.systemVersion
    webView.configuration.applicationNameForUserAgent = "Safari/604.1"
    webView.customUserAgent = "Mozilla/5.0 (\(deviceModel); CPU \(deviceModel) OS \(osVersion.replacingOccurrences(of: ".", with: "_")) like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/\(osVersion) Mobile/15E148 Safari/604.1 PWAShell"

    webView.addObserver(NSO, forKeyPath: #keyPath(WKWebView.estimatedProgress), options: NSKeyValueObservingOptions.new, context: nil)
    
    #if DEBUG
    if #available(iOS 16.4, *) {
        webView.isInspectable = true
    }
    #endif
    
    return webView
}

func setAppStoreAsReferrer(contentController: WKUserContentController) {
    let scriptSource = "document.referrer = `app-info://platform/ios-store`;"
    let script = WKUserScript(source: scriptSource, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
    contentController.addUserScript(script);
}

func setCustomCookie(webView: WKWebView) {
    let _platformCookie = HTTPCookie(properties: [
        .domain: rootUrl.host!,
        .path: "/",
        .name: platformCookie.name,
        .value: platformCookie.value,
        .secure: "FALSE",
        .expires: NSDate(timeIntervalSinceNow: 31556926)
    ])!

    webView.configuration.websiteDataStore.httpCookieStore.setCookie(_platformCookie)

}

func calcWebviewFrame(webviewView: UIView, toolbarView: UIToolbar?) -> CGRect{
    if ((toolbarView) != nil) {
        return CGRect(x: 0, y: toolbarView!.frame.height, width: webviewView.frame.width, height: webviewView.frame.height - toolbarView!.frame.height)
    }
    else {
        let winScene = UIApplication.shared.connectedScenes.first
        let windowScene = winScene as! UIWindowScene
        var statusBarHeight = windowScene.statusBarManager?.statusBarFrame.height ?? 0

        switch displayMode {
        case "fullscreen":
            #if targetEnvironment(macCatalyst)
                if let titlebar = windowScene.titlebar {
                    titlebar.titleVisibility = .hidden
                    titlebar.toolbar = nil
                }
            #endif
            return CGRect(x: 0, y: 0, width: webviewView.frame.width, height: webviewView.frame.height)
        default:
            #if targetEnvironment(macCatalyst)
            statusBarHeight = 29
            #endif
            let windowHeight = webviewView.frame.height - statusBarHeight
            return CGRect(x: 0, y: statusBarHeight, width: webviewView.frame.width, height: windowHeight)
        }
    }
}

extension ViewController: WKUIDelegate, WKDownloadDelegate {
    // redirect new tabs to main webview
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if (navigationAction.targetFrame == nil) {
            webView.load(navigationAction.request)
        }
        return nil
    }
    // restrict navigation to target host, open external links in 3rd party apps
    // (Ddong 수정) 카카오맵·네이버지도·문자·전화 같은 앱 주소는 바로 그 앱으로,
    // 다른 사이트는 앱 안의 사파리 창으로 열어서 앱 화면에 갇히지 않게 함
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let requestUrl = navigationAction.request.url else {
            return decisionHandler(.cancel)
        }
        let scheme = requestUrl.scheme?.lowercased() ?? ""
        if (scheme == "about") {
            return decisionHandler(.allow)
        }
        if (navigationAction.shouldPerformDownload || scheme == "blob") {
            return decisionHandler(.download)
        }
        if (scheme != "http" && scheme != "https") {
            decisionHandler(.cancel)
            if requestUrl.isFileURL {
                downloadAndOpenFile(url: requestUrl.absoluteURL)
            } else {
                // kakaomap://, nmap://, sms:, tel:, mailto:, kakaoopen:// ...
                UIApplication.shared.open(requestUrl, options: [:], completionHandler: nil)
            }
            return
        }

        let requestHost = requestUrl.host ?? ""

        // Apple 지도 링크는 아이폰 기본 지도 앱으로 바로 열기 (App Store 심사 지침 4)
        if (requestHost == "maps.apple.com" || requestHost.hasSuffix(".maps.apple.com")) {
            decisionHandler(.cancel)
            UIApplication.shared.open(requestUrl, options: [:], completionHandler: nil)
            return
        }

        let matchingAuthOrigin = authOrigins.first(where: { !$0.isEmpty && requestHost.range(of: $0) != nil })
        if (matchingAuthOrigin != nil) {
            decisionHandler(.allow)
            if (toolbarView.isHidden) {
                toolbarView.isHidden = false
                webView.frame = calcWebviewFrame(webviewView: webviewView, toolbarView: toolbarView)
            }
            return
        }

        let matchingHostOrigin = allowedOrigins.first(where: { requestHost.range(of: $0) != nil })
        if (matchingHostOrigin != nil) {
            // Open in main webview
            decisionHandler(.allow)
            if (!toolbarView.isHidden) {
                toolbarView.isHidden = true
                webView.frame = calcWebviewFrame(webviewView: webviewView, toolbarView: nil)
            }
            return
        }

        // 다른 사이트 안의 작은 창(iframe)은 그대로 허용
        if let target = navigationAction.targetFrame, !target.isMainFrame {
            return decisionHandler(.allow)
        }

        // 그 밖의 사이트(지도 웹페이지, 오픈채팅, 공공데이터포털 등)는 사파리 창으로
        decisionHandler(.cancel)
        let safariViewController = SFSafariViewController(url: requestUrl)
        self.present(safariViewController, animated: true, completion: nil)
    }

    // Handle javascript: `window.alert(message: String)`
    func webView(_ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void) {

        // Set the message as the UIAlertController message
        let alert = UIAlertController(
            title: nil,
            message: message,
            preferredStyle: .alert
        )

        // Add a confirmation action “OK”
        let okAction = UIAlertAction(
            title: "OK",
            style: .default,
            handler: { _ in
                // Call completionHandler
                completionHandler()
            }
        )
        alert.addAction(okAction)

        // Display the NSAlert
        present(alert, animated: true, completion: nil)
    }
    // Handle javascript: `window.confirm(message: String)`
    func webView(_ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void) {

        // Set the message as the UIAlertController message
        let alert = UIAlertController(
            title: nil,
            message: message,
            preferredStyle: .alert
        )

        // Add a confirmation action “Cancel”
        let cancelAction = UIAlertAction(
            title: "Cancel",
            style: .cancel,
            handler: { _ in
                // Call completionHandler
                completionHandler(false)
            }
        )

        // Add a confirmation action “OK”
        let okAction = UIAlertAction(
            title: "OK",
            style: .default,
            handler: { _ in
                // Call completionHandler
                completionHandler(true)
            }
        )
        alert.addAction(cancelAction)
        alert.addAction(okAction)

        // Display the NSAlert
        present(alert, animated: true, completion: nil)
    }
    // Handle javascript: `window.prompt(prompt: String, defaultText: String?)`
    func webView(_ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void) {

        // Set the message as the UIAlertController message
        let alert = UIAlertController(
            title: nil,
            message: prompt,
            preferredStyle: .alert
        )

        // Add a confirmation action “Cancel”
        let cancelAction = UIAlertAction(
            title: "Cancel",
            style: .cancel,
            handler: { _ in
                // Call completionHandler
                completionHandler(nil)
            }
        )

        // Add a confirmation action “OK”
        let okAction = UIAlertAction(
            title: "OK",
            style: .default,
            handler: { _ in
                // Call completionHandler with Alert input
                if let input = alert.textFields?.first?.text {
                    completionHandler(input)
                }
            }
        )

        alert.addTextField { textField in
            textField.placeholder = defaultText
        }
        alert.addAction(cancelAction)
        alert.addAction(okAction)

        // Display the NSAlert
        present(alert, animated: true, completion: nil)
    }

    func downloadAndOpenFile(url: URL){

        let destinationFileUrl = url
        let sessionConfig = URLSessionConfiguration.default
        let session = URLSession(configuration: sessionConfig)
        let request = URLRequest(url:url)
        let task = session.downloadTask(with: request) { (tempLocalUrl, response, error) in
            if let tempLocalUrl = tempLocalUrl, error == nil {
                if let statusCode = (response as? HTTPURLResponse)?.statusCode {
                    print("Successfully download. Status code: \(statusCode)")
                }
                do {
                    try FileManager.default.copyItem(at: tempLocalUrl, to: destinationFileUrl)
                    self.openFile(url: destinationFileUrl)
                } catch (let writeError) {
                    print("Error creating a file \(destinationFileUrl) : \(writeError)")
                }
            } else {
                print("Error took place while downloading a file. Error description: \(error?.localizedDescription ?? "N/A") ")
            }
        }
        task.resume()
    }

    // func downloadAndOpenBase64File(base64String: String) {
    //     // Split the base64 string to extract the data and the file extension
    //     let components = base64String.components(separatedBy: ";base64,")

    //     // Make sure the base64 string has the correct format
    //     guard components.count == 2, let format = components.first?.split(separator: "/").last else {
    //         print("Invalid base64 string format")
    //         return
    //     }

    //     // Remove the data type prefix to get the base64 data
    //     let dataString = components.last!

    //     if let imageData = Data(base64Encoded: dataString) {
    //         let documentsUrl: URL  =  FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
    //         let destinationFileUrl = documentsUrl.appendingPathComponent("image.\(format)")

    //         do {
    //             try imageData.write(to: destinationFileUrl)
    //             self.openFile(url: destinationFileUrl)
    //         } catch {
    //             print("Error writing image to file url: \(destinationFileUrl): \(error)")
    //         }
    //     }
    // }

    func openFile(url: URL) {
        self.documentController = UIDocumentInteractionController(url: url)
        self.documentController?.delegate = self
        self.documentController?.presentPreview(animated: true)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                suggestedFilename: String,
                completionHandler: @escaping (URL?) -> Void) {

        let documentsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let fileURL = documentsPath.appendingPathComponent(suggestedFilename)

        // Remove existing file if it exists, otherwise it may show an old file/content just by having the same name.
        if FileManager.default.fileExists(atPath: fileURL.path) {
            try? FileManager.default.removeItem(at: fileURL)
        }

        self.openFile(url: fileURL)
        completionHandler(fileURL)
    }
}


// MARK: - 위치 (navigator.geolocation 대신 iOS 위치 서비스 사용)
// WKWebView 기본 위치 기능은 앱을 켤 때마다 "…위치를 사용하려고 합니다" 창을 다시 띄워요.
// 여기서 CLLocationManager로 직접 받으면 iOS 시스템 허용(한 번)만으로 계속 쓸 수 있어요.
final class GeoBridge: NSObject, WKScriptMessageHandler, CLLocationManagerDelegate {
    static let shared = GeoBridge()
    weak var webView: WKWebView?
    private let manager = CLLocationManager()
    private var pending: [Int] = []

    static let polyfill = """
    (function(){
      if (!window.webkit || !window.webkit.messageHandlers || !window.webkit.messageHandlers.geo) return;
      var n = 0, cbs = {};
      function err(code, msg){ return { code: code, message: msg, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }; }
      window.__geoCb = function(id, ok, lat, lng, acc, code){
        var c = cbs[id]; if (!c) return; delete cbs[id];
        if (ok) c.s({ coords: { latitude: lat, longitude: lng, accuracy: acc, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
        else if (c.e) c.e(err(code, code === 1 ? "denied" : "unavailable"));
      };
      var geo = {
        getCurrentPosition: function(s, e){ var id = ++n; cbs[id] = { s: s, e: e }; window.webkit.messageHandlers.geo.postMessage({ id: id }); },
        watchPosition: function(s, e, o){ geo.getCurrentPosition(s, e, o); return 0; },
        clearWatch: function(){}
      };
      try { Object.defineProperty(navigator, "geolocation", { value: geo, configurable: true }); } catch (x) {}
    })();
    """

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let id = (body["id"] as? NSNumber)?.intValue else { return }
        pending.append(id)
        start()
    }

    private func start() {
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            finish(nil, code: 1)
        default:
            // 1분 안에 받은 위치가 있으면 바로 사용
            if let loc = manager.location, -loc.timestamp.timeIntervalSinceNow < 60 { finish(loc, code: 0); return }
            manager.requestLocation()
        }
    }

    func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        if !pending.isEmpty && m.authorizationStatus != .notDetermined { start() }
    }

    func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if let loc = locations.last { finish(loc, code: 0) }
    }

    func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        finish(nil, code: (error as? CLError)?.code == .denied ? 1 : 2)
    }

    private func finish(_ loc: CLLocation?, code: Int) {
        let ids = pending
        pending = []
        guard !ids.isEmpty else { return }
        let js = ids.map { id -> String in
            if let l = loc {
                return "window.__geoCb&&window.__geoCb(\(id),true,\(l.coordinate.latitude),\(l.coordinate.longitude),\(l.horizontalAccuracy),0);"
            }
            return "window.__geoCb&&window.__geoCb(\(id),false,0,0,0,\(code));"
        }.joined()
        DispatchQueue.main.async { [weak self] in self?.webView?.evaluateJavaScript(js, completionHandler: nil) }
    }
}

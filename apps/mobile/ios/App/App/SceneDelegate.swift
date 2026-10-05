import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        // #1074 — a URL opened while the app is running arrives here rather than
        // on the app delegate, because `Info.plist` declares a scene manifest.
        // A sign-in SDK's callback is consumed; everything else is Capacitor's,
        // which is how a link becomes `appUrlOpen` in the web layer.
        let unhandled = URLContexts.filter { !NativeSignInUrl.handle($0.url) }
        guard !unhandled.isEmpty else { return }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: Set(unhandled))
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

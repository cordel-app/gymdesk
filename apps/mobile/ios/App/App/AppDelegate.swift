import UIKit
import Capacitor

// #1074 (mobile app WP3) — the native side of Google sign-in and of the push
// token, and the two are the only things this delegate does beyond Capacitor's
// own template.
//
// Both are written so the project **compiles with or without the SDK involved**
// (`#if canImport`), for two different reasons that happen to have one answer:
// `GoogleSignIn` is a transitive dependency of `@capgo/capacitor-social-login`
// rather than a product this target declares, and `FirebaseMessaging` is added
// to the Xcode project by hand along with the `GoogleService-Info.plist` only
// its owner has (`docs/mobile-runbook.md`). A guard is what keeps a build that
// has neither from failing to compile, and what keeps the code that needs them
// in the repository rather than in a wiki page.
#if canImport(GoogleSignIn)
import GoogleSignIn
#endif
#if canImport(FirebaseCore)
import FirebaseCore
#endif
#if canImport(FirebaseMessaging)
import FirebaseMessaging
#endif

/// The **one** place a URL opened on the app is offered to a sign-in SDK.
///
/// It is asked from two entry points, because iOS delivers a URL to whichever
/// of them the app declares: `UIApplicationSceneManifest` is in `Info.plist`, so
/// a running app gets `scene(_:openURLContexts:)` (`SceneDelegate`), while
/// `application(_:open:options:)` is what the plugin's own README documents and
/// what an app without a scene manifest would receive. One rule and two
/// callers, so neither delegate tests for a provider's callback itself.
enum NativeSignInUrl {
    /// `true` when a sign-in SDK consumed the URL and Capacitor must not see it.
    static func handle(_ url: URL) -> Bool {
        #if canImport(GoogleSignIn)
        return GIDSignIn.sharedInstance.handle(url)
        #else
        // No Google SDK in this build: the Members App renders no native Google
        // button either (WP2's `googleNativeConfig()` answers `null` without
        // client ids), so there is no callback to consume.
        return false
        #endif
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        configureFirebaseIfAvailable()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        if NativeSignInUrl.handle(url) { return true }
        // Anything else is Capacitor's: a custom-scheme link reaches the web
        // layer as `appUrlOpen`, which WP2's `appUrlOpenPath()` turns into an
        // in-app path.
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }

    // MARK: - Push

    /// Firebase is configured only when this build actually has a Firebase app:
    /// `FirebaseApp.configure()` raises if `GoogleService-Info.plist` is not in
    /// the bundle, and that file is per app profile and never committed
    /// (design rule 1), so a developer build without it must still launch.
    private func configureFirebaseIfAvailable() {
        #if canImport(FirebaseCore)
        guard Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil else { return }
        if FirebaseApp.app() == nil { FirebaseApp.configure() }
        #endif
    }

    /// The token the Members App registers with `POST /me/devices` (#1072) has
    /// to be the **FCM** token, because delivery is FCM HTTP v1 — an APNs token
    /// posted to FCM is a token FCM will never deliver to. So when Firebase is
    /// present the APNs token is handed to it and its own token is what reaches
    /// the web layer's `registration` listener; without Firebase the APNs token
    /// is forwarded unchanged, which is what Capacitor does by itself and is
    /// still the right value for an APNs-direct sender.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        #if canImport(FirebaseMessaging)
        if FirebaseApp.app() != nil {
            Messaging.messaging().apnsToken = deviceToken
            Messaging.messaging().token { token, error in
                if let token {
                    NotificationCenter.default.post(
                        name: .capacitorDidRegisterForRemoteNotifications,
                        object: token
                    )
                } else {
                    NotificationCenter.default.post(
                        name: .capacitorDidFailToRegisterForRemoteNotifications,
                        object: error
                    )
                }
            }
            return
        }
        #endif
        NotificationCenter.default.post(
            name: .capacitorDidRegisterForRemoteNotifications,
            object: deviceToken
        )
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(
            name: .capacitorDidFailToRegisterForRemoteNotifications,
            object: error
        )
    }
}

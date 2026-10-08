package com.cordel.fitness;

import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.BridgeActivity;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "MainActivity";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        ensureFirebaseApp();
        super.onCreate(savedInstanceState);
    }

    /**
     * #1077 (WP5) — a shell with no `google-services.json` must not crash when the
     * Members App asks for a push token.
     *
     * `@capacitor/push-notifications`' `register()` calls
     * `FirebaseMessaging.getInstance()`, which throws `IllegalStateException` when no
     * default Firebase app exists. It throws on a plugin thread, so the web
     * app's `try/catch` around `register()` never sees it and the whole process dies:
     * found in the Android emulator, where signing in was followed by an app that
     * quit and came back signed out. The docs had said such a build "still launches,
     * it just cannot receive a push".
     *
     * With the real file present Gradle's google-services plugin has already created
     * the default app and this does nothing. Without it, an obviously unconfigured
     * placeholder (`unconfigured`) is created, so `register()` reaches the plugin's own
     * failure path and reports `registrationError` to the page. No token is ever
     * obtained from it. This is WP2's "absent, never broken" rule one layer down.
     */
    private void ensureFirebaseApp() {
        try {
            if (!FirebaseApp.getApps(this).isEmpty()) return;
            FirebaseApp.initializeApp(
                this,
                new FirebaseOptions.Builder()
                    .setApplicationId("1:0:android:0000000000000000")
                    .setApiKey("unconfigured")
                    .setProjectId("unconfigured")
                    .build()
            );
            Log.w(TAG, "No google-services.json: push is unconfigured, registration will report an error.");
        } catch (Exception e) {
            Log.w(TAG, "Could not create the placeholder Firebase app", e);
        }
    }
}

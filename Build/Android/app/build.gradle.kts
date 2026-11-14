import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

val versionProperties = Properties().apply {
    rootProject.file("../version.properties").inputStream().use(::load)
}
val appVersion = versionProperties.getProperty("APP_VERSION")
    ?: error("APP_VERSION is missing from version.properties")
val appVersionCode = versionProperties.getProperty("ANDROID_VERSION_CODE")?.toIntOrNull()
    ?: error("ANDROID_VERSION_CODE must be an integer in version.properties")
val releaseStorePath = System.getenv("MINIAPPS_ANDROID_KEYSTORE")
val releaseStorePassword = System.getenv("MINIAPPS_ANDROID_STORE_PASSWORD")
val releaseKeyAlias = System.getenv("MINIAPPS_ANDROID_KEY_ALIAS")
val releaseKeyPassword = System.getenv("MINIAPPS_ANDROID_KEY_PASSWORD")
val releaseSigningReady = listOf(releaseStorePath, releaseStorePassword, releaseKeyAlias, releaseKeyPassword)
    .all { !it.isNullOrBlank() } && file(releaseStorePath!!).isFile
// Explicit local builds use the SDK's persistent debug certificate, retaining release behavior.
val localSigning = providers.gradleProperty("miniapps.localSigning").orNull == "true"

val telegramPackageAssets = layout.buildDirectory.dir("generated/telegram-assets")
val prepareTelegramPackage by tasks.registering(Sync::class) {
    val source = rootProject.file("../../DefaultContent/MiniApps")
    into(telegramPackageAssets)
    from(source.resolve("Modules/telegram")) { into("telegram-package/module") }
    from(source.resolve("telegram-client")) { into("telegram-package/client") }
    from(rootProject.file("../Telegram/api-credentials.local.json")) { into("telegram-package") }
}
// Peer transfer needs a debug runtime.
val bundledApps = listOf("date-difference-calculator-v4", "esp-light", "mini-paint", "shopping-list",
    "telegram-client", "telegram-cloud", "worktime-tracker")
val bundledAppArchives = bundledApps.map { app ->
    tasks.register<Zip>("packageBundledApp-${app}") {
        val source = rootProject.file("../../DefaultContent/MiniApps/$app")
        from(source) {
            exclude("**/storage.json", "**/storage.json.bak", "**/.runtime/**", "tests/**", "tools/**")
            includeEmptyDirs = false
        }
        archiveFileName.set("$app.zip")
        destinationDirectory.set(layout.buildDirectory.dir("bundled-app-archives"))
        isPreserveFileTimestamps = false
        isReproducibleFileOrder = true
        doFirst { check(source.resolve("manifest.json").isFile) { "Missing bundled mini-app: $app" } }
    }
}
val bundledAppAssets = layout.buildDirectory.dir("generated/bundled-app-assets")
val prepareBundledApps by tasks.registering(Sync::class) {
    into(bundledAppAssets)
    into("bundled-apps") { from(bundledAppArchives.map { it.flatMap { archive -> archive.archiveFile } }) }
}

android { namespace = "com.example.miniapp"; compileSdk = 36
    sourceSets {
        getByName("main") {
            manifest.srcFile("../../../Code/Android/app/src/main/AndroidManifest.xml")
            java.srcDirs("../../../Code/Android/app/src/main/java")
            res.srcDirs("../../../Code/Android/app/src/main/res")
            assets.srcDirs("../../../Code/Framework/shared", "../../../Code/Android/app/src/main/assets",
                "../../../DefaultContent/Interface")
            assets.srcDir(telegramPackageAssets)
            assets.srcDir(bundledAppAssets)
        }
        getByName("test").java.srcDirs("../../../Code/Android/app/src/test/java")
    }
    layout.buildDirectory.set(rootProject.layout.projectDirectory.dir("../../Cache/Android/app"))
    defaultConfig { applicationId = "com.example.miniapp"; minSdk = 24; targetSdk = 36; versionCode = appVersionCode; versionName = appVersion
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner" }
    signingConfigs {
        if (releaseSigningReady) create("release") {
            storeFile = file(releaseStorePath!!)
            storePassword = releaseStorePassword
            keyAlias = releaseKeyAlias
            keyPassword = releaseKeyPassword
        }
    }
    buildTypes { release { isMinifyEnabled = true; isShrinkResources = true; if (localSigning) signingConfig = signingConfigs.getByName("debug") else if (releaseSigningReady) signingConfig = signingConfigs.getByName("release"); proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro") } }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }
    buildFeatures { buildConfig = true }
}
tasks.configureEach {
    if (name == "preBuild") dependsOn(prepareTelegramPackage, prepareBundledApps)
    if (name == "packageRelease" || name == "signReleaseBundle") doFirst {
        check(localSigning || releaseSigningReady) { "Release signing requires MINIAPPS_ANDROID_KEYSTORE, MINIAPPS_ANDROID_STORE_PASSWORD, MINIAPPS_ANDROID_KEY_ALIAS, and MINIAPPS_ANDROID_KEY_PASSWORD; use BuildAndroid.cmd Local for a locally signed APK" }
    }
}
kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }
dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
}

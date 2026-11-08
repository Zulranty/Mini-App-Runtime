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

android { namespace = "com.example.miniapp"; compileSdk = 35
    sourceSets {
        getByName("main") {
            manifest.srcFile("../../../Code/Android/app/src/main/AndroidManifest.xml")
            java.srcDirs("../../../Code/Android/app/src/main/java")
            res.srcDirs("../../../Code/Android/app/src/main/res")
            assets.srcDirs("../../../Code/Framework/shared", "../../../Code/Android/app/src/main/assets")
        }
        getByName("test").java.srcDirs("../../../Code/Android/app/src/test/java")
    }
    layout.buildDirectory.set(rootProject.layout.projectDirectory.dir("../../Cache/Android/app"))
    defaultConfig { applicationId = "com.example.miniapp"; minSdk = 24; targetSdk = 35; versionCode = appVersionCode; versionName = appVersion
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
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    buildFeatures { buildConfig = true }
}
tasks.configureEach {
    if (name == "packageRelease") doFirst {
        check(localSigning || releaseSigningReady) { "Release signing requires MINIAPPS_ANDROID_KEYSTORE, MINIAPPS_ANDROID_STORE_PASSWORD, MINIAPPS_ANDROID_KEY_ALIAS, and MINIAPPS_ANDROID_KEY_PASSWORD; use BuildAndroid.cmd Local for a locally signed APK" }
    }
}
kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }
dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
}

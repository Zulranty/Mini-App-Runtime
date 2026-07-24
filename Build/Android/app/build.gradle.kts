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
    buildTypes { release { isMinifyEnabled = true; isShrinkResources = true; signingConfig = signingConfigs.getByName("debug"); proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro") } }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    buildFeatures { buildConfig = true }
}
kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }
dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
}

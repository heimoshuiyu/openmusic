import java.util.Properties

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.compose)
  alias(libs.plugins.kotlin.serialization)
}

// release 签名：apps/android/keystore.properties（gitignore，本机生成）
// 缺文件时跳过签名——产物为 unsigned APK，仅本机装机用
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
  if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

android {
  namespace = "dev.hmsy.openmusic"
  compileSdk = 36

  defaultConfig {
    applicationId = "dev.hmsy.openmusic"
    minSdk = 26
    targetSdk = 36
    versionCode = 14
    versionName = "0.1.13"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  signingConfigs {
    if (keystorePropsFile.exists()) {
      create("release") {
        storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
        storePassword = keystoreProps.getProperty("storePassword")
        keyAlias = keystoreProps.getProperty("keyAlias")
        keyPassword = keystoreProps.getProperty("keyPassword")
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      if (keystorePropsFile.exists()) signingConfig = signingConfigs.getByName("release")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

dependencies {
  val composeBom = platform(libs.compose.bom)
  implementation(composeBom)

  implementation(libs.compose.ui)
  implementation(libs.compose.foundation)
  implementation(libs.compose.material3)
  implementation(libs.compose.animation)
  implementation(libs.compose.ui.tooling.preview)
  debugImplementation(libs.compose.ui.tooling)

  implementation(libs.activity.compose)
  implementation(libs.navigation.compose)
  implementation(libs.lifecycle.runtime.compose)
  implementation(libs.lifecycle.viewmodel.compose)
  implementation(libs.lifecycle.service)
  implementation(libs.core.ktx)

  implementation(libs.media3.exoplayer)
  implementation(libs.media3.session)
  implementation(libs.media3.okhttp)
  implementation(libs.media3.database)

  implementation(libs.datastore.preferences)

  implementation(libs.okhttp)
  implementation(libs.coil.compose)
  implementation(libs.coil.network.okhttp)

  implementation(libs.kotlinx.serialization.json)
  implementation(libs.kotlinx.coroutines.android)

  testImplementation(libs.junit)
  androidTestImplementation("androidx.test:runner:1.6.2")
  androidTestImplementation("androidx.test.ext:junit:1.2.1")
  androidTestImplementation(composeBom)
  androidTestImplementation("androidx.compose.ui:ui-test-junit4")
  androidTestImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
}

// Package the actual Web conversation, including lazy Markdown chunks. No running Vite server
// or remote executable code is needed on the phone. bun install at the repository root first.
val webRoot = rootProject.file("../web")
val assistantAssets = layout.buildDirectory.dir("generated/assistantAssets")
val buildAssistant by tasks.registering(Exec::class) {
  workingDir(webRoot)
  inputs.dir(webRoot.resolve("src")); inputs.dir(rootProject.file("../../packages/shared/src"))
  inputs.files(webRoot.resolve("android-assistant.html"), webRoot.resolve("android-admin.html"), webRoot.resolve("vite.android.config.ts"), webRoot.resolve("vite.config.ts"), webRoot.resolve("package.json"), rootProject.file("../../bun.lock"))
  outputs.dir(assistantAssets)
  commandLine("bun", "run", "vite", "build", "--config", "vite.android.config.ts", "--outDir", assistantAssets.get().dir("assistant").asFile.absolutePath)
}
android.sourceSets["main"].assets.directories.add(assistantAssets.get().asFile.path)
tasks.named("preBuild").configure { dependsOn(buildAssistant) }

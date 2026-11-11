plugins {
    // AGP 9 compiles Kotlin itself; org.jetbrains.kotlin.android is not applied.
    id("com.android.application")
}

android {
    namespace = "dev.grokbot.local"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.grokbot.local"
        minSdk = 28
        targetSdk = 36
        // The client follows the official desktop interface version it is built from.
        versionCode = 7102
        versionName = "0.71.2"
    }

    buildTypes {
        release {
            // Unsigned on purpose: android/patchers/patch.mjs adds the interface
            // and signs the final APK with the user's own key.
            isMinifyEnabled = true
            isShrinkResources = false
            isCrunchPngs = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        resources {
            excludes += setOf("META-INF/*.version", "META-INF/**/LICENSE*", "kotlin/**", "DebugProbesKt.bin")
        }
    }

    lint {
        // The shell is tiny; release lint would download the full lint toolchain.
        checkReleaseBuilds = false
    }

    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
}

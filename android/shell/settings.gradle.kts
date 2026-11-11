// The Android shell contains only ProkBot Plus code. The official interface is
// added later by android/patchers/patch.mjs from the user's own download.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "GrokBotLocalShell"
include(":app")

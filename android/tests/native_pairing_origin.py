"""After assembling the Android shell, exercise the actual Kotlin bytecode with two loopback origins."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile

def main():
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('--classes',type=Path); p.add_argument('--stdlib',type=Path); args=p.parse_args()
    tests=Path(__file__).resolve().parent; android=tests.parent
    classes=args.classes or android/'shell/app/build/intermediates/built_in_kotlinc/release/compileReleaseKotlin/classes'
    if not (classes/'dev/grokbot/local/Pairing.class').is_file(): p.error('assemble the shell first or provide --classes')
    sdk=Path(os.environ.get('ANDROID_HOME') or os.environ['ANDROID_SDK_ROOT'])/'platforms/android-36/android.jar'
    cache=Path(os.environ.get('GRADLE_USER_HOME',Path.home()/'.gradle'))/'caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib'
    jars=sorted(x for x in cache.glob('*/*/kotlin-stdlib-*.jar') if '-sources' not in x.name and '-javadoc' not in x.name)
    stdlib=args.stdlib or (jars[-1] if jars else None)
    if not stdlib or not stdlib.is_file() or not sdk.is_file(): p.error('Android API 36 and cached Kotlin stdlib required')
    jdk=Path(os.environ['JAVA_HOME'])/'bin';ext='.exe' if os.name=='nt' else ''
    with tempfile.TemporaryDirectory(prefix='prokbot-native-origin-') as tmp:
        cp=os.pathsep.join(map(str,[tmp,classes,stdlib,sdk]));sources=sorted((tests/'native-pairing').glob('*.java'))
        subprocess.run([str(jdk/('javac'+ext)),'-J-Xms16m','-J-Xmx128m','--add-modules','jdk.httpserver','-cp',cp,'-d',tmp,*map(str,sources)],check=True,timeout=35)
        subprocess.run([str(jdk/('java'+ext)),'-Xms16m','-Xmx96m','--add-modules','jdk.httpserver','-cp',cp,'dev.grokbot.local.PairingOriginProbe'],check=True,timeout=30)

if __name__=='__main__':main()

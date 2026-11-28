<div align="center">

# ProkBot Plus

**Grok Bot'u seçtiğiniz modellerle kendi sunucunuzda çalıştırın.**

<p>
<!-- client-badges:start -->
  <a href="#client-versions"><img alt="Windows official 1.3.0 x64" src="https://img.shields.io/badge/Windows%20official-1.3.0%20x64-0078D4?logo=windows&logoColor=white"></a>
  <a href="#client-versions"><img alt="Windows patch accepts 1.3.0 x64 (recommended), 1.2.3, 1.1.0, 0.71.2" src="https://img.shields.io/badge/Windows%20patch%20accepts-1.3.0%20x64%20(recommended)%2C%201.2.3%2C%201.1.0%2C%200.71.2-237E55?logo=windows&logoColor=white"></a>
  <a href="#client-versions"><img alt="Linux official 1.3.0 x64 / ARM64" src="https://img.shields.io/badge/Linux%20official-1.3.0%20x64%20%2F%20ARM64-237E55?logo=linux&logoColor=white"></a>
  <a href="#client-versions"><img alt="macOS official 1.3.0 ARM64 / Intel" src="https://img.shields.io/badge/macOS%20official-1.3.0%20ARM64%20%2F%20Intel-111111?logo=apple&logoColor=white"></a>
  <a href="#client-versions"><img alt="iOS official 1.28.0" src="https://img.shields.io/badge/iOS%20official-1.28.0-111111?logo=apple&logoColor=white"></a>
  <a href="#client-versions"><img alt="Android shell 1.1.0" src="https://img.shields.io/badge/Unofficial%20Android-1.1.0-237E55?logo=android&logoColor=white"></a>
  <a href="#client-versions"><img alt="Web client 1.1.0" src="https://img.shields.io/badge/Web%20client-1.1.0-237E55?logo=googlechrome&logoColor=white"></a>
<!-- client-badges:end -->
  <img alt="Ticari Olmayan Lisans" src="https://img.shields.io/badge/License-Noncommercial-6B7280">
  <a href="https://linux.do"><img alt="LINUX DO" src="https://img.shields.io/badge/Community-LINUX%20DO-F5A623"></a>
</p>

[简体中文](README.md) · [English](README.en.md) · **Türkçe**

</div>

<p align="center">
  <img src="docs/images/hero-en.jpg" alt="Üç istemci: solda Bot'un web'de arama yapıp resim çizdiği Windows istemcisi; ortada bir tarayıcıdaki web istemcisi; sağda Android uygulamasında bir sohbet">
</p>

<table>
  <tr>
    <td width="50%" valign="top"><img src="docs/images/card-search.jpg" alt="Windows istemcisi: Bot Fragrant Hills'teki kızıl sonbahar yapraklarının ne zaman görüleceğini araştırır, kaynaklarını listeler ve suluboya bir resim çizer"><br><b>Web araması ve görseller</b><br><sub>Kaynaklar listelenir ve resimler doğrudan sohbette görünür.</sub></td>
    <td width="50%" valign="top"><img src="docs/images/card-approve.jpg" alt="Bot Windows bilgisayarda bir komut çalıştırmadan önce bir kart Her zaman izin ver, Bir kez izin ver ve Asla seçeneklerini sunar"><br><b>Kendi bilgisayarınızda komutlar</b><br><sub>Windows istemcisinde Bot önce size sorar.</sub></td>
  </tr>
  <tr>
    <td valign="top"><img src="docs/images/card-phone-en.jpg" alt="Bir telefonda Bot listesi ve Bot'un Edinburgh'da bir hafta sonunu tablo olarak düzenlediği Gezi Planlayıcı ile bir sohbet"><br><b>Telefonunuzda</b><br><sub>Resmî telefon uygulaması gibi düzenlenmiştir; Android uygulaması ve web istemcisi bu arayüzü paylaşır.</sub></td>
    <td valign="top"><img src="docs/images/card-tablet-en.jpg" alt="Yatay konumda bir iPad'de web istemcisi: solda Bot listesi ve sağda Code Helper'dan bir Python betiği"><br><b>Tabletler ve herhangi bir tarayıcı</b><br><sub>Web istemcisi ekrana uyum sağlar; bir eşleştirme koduyla oturum açın.</sub></td>
  </tr>
  <tr>
    <td valign="top"><img src="docs/images/card-models-en.jpg" alt="Host yönetici sitesindeki sohbet modeli sayfası: iki model hizmeti, anthropic ve openai-responses ve iki model profili"><br><b>Kendi modelleriniz</b><br><sub>Bot başına bir model ve yedeklemelerle Anthropic, OpenAI Responses veya OpenAI Chat API'leri.</sub></td>
    <td valign="top"><img src="docs/images/card-pair-en.jpg" alt="Android uygulamasında ilk bağlantı: Host adresini ve 6 karakterlik eşleştirme kodunu girin"><br><b>Bir kodla eşleştirin</b><br><sub>Yönetici sayfasından Host adresini ve 6 karakterlik kodu girin.</sub></td>
  </tr>
</table>
<p align="center"><sub>Tüm ekran görüntüleri demo verisi kullanır. Windows ekran görüntüleri Çince arayüzü gösterir; istemciler İngilizceyi de destekler.</sub></p>

## Nedir

Grok Bot, xAI'ın yapay zeka asistanı uygulamasıdır. Sohbet etmenin yanı sıra Bot'larının komut çalıştırdıkları, tarayıcı kullandıkları ve dosyalarla çalıştıkları kendi Linux bilgisayarları vardır; ayrıca belleğe ve zamanlanmış görevlere sahiptirler. Resmî uygulama yalnızca resmî buluta bağlanır.

[ProkBot](https://gitee.com/ahaduoduoduo/ProkBot), sunucu tarafını Docker ile kendi sunucunuza taşır ve resmî istemcileri ona bağlanacak şekilde yamalar. **ProkBot Plus** bunun üzerine şunları ekler:

- **Daha fazla istemci**: Windows ve Linux (x64 / ARM64) masaüstü istemcileri, kendi Android uygulamamız ve herhangi bir tarayıcıda çalışan bir web istemcisi;
- **Daha fazla model API'si**: Bot başına bir ana model, akıl yürütme düzeyi ve yedek modellerle Anthropic Messages, OpenAI Responses ve OpenAI Chat;
- **Düzeltmeler**: web araması, görsel üretimi, mesaj sırası, otomatik inceleme ve daha fazlası;
- **Dağıtım araçları**: denetlemek, başlatmak, güncellemek ve yedeklemek için tek komut, ayrıca bir yapay zekanın izleyebileceği bir dağıtım kılavuzu.

Arayüz, araç çağrıları, bellek, zamanlanmış görevler ve onaylar resmî olanlardır. Sohbetler, dosyalar ve bellek sunucunuzda kalır; telemetri ve otomatik güncellemeler kapalıdır.

> Resmî değildir ve xAI ile bağlantılı değildir. Yalnızca ticari olmayan kullanım içindir; bkz. [Lisans ve bildirimler](#lisans-ve-bildirimler).

Faydalı bulursanız bir yıldız başkalarının da onu bulmasına yardımcı olur.

<a id="server-requirements"></a><a id="what-you-need"></a>
## Sunucu gereksinimleri

Modeller kendi API'leri üzerinden çalışır, bu nedenle **sunucunun GPU'ya ihtiyacı yoktur**. İki kapsayıcı çalıştırır: Host ve Bot'un Linux bilgisayarı.

| | Asgari | Önerilen |
| --- | --- | --- |
| CPU / bellek | 2 çekirdek / 4 GB | 4 çekirdek / 8 GB |
| Boş disk alanı | 30 GB | 50 GB |
| Sistem | 64-bit Linux, Compose v2 ile Docker, Python 3.10+ | Ubuntu 24.04 (kendi Docker paketleri yeterlidir); Docker 26+ ve Compose 2.26+ ile Bot kendi bilgisayarındaki belleğini okuyabilir |

- Testlerde 2 çekirdek / 4 GB ve 4 çekirdek / 8 GB üzerinde sıfırdan dağıtımların ikisi de çalıştı; 2 çekirdek / 2 GB çalışmadı. Bir kişi veya bir hane için boyutlandırılmıştır; birkaç kişi tarafından yoğun eşzamanlı kullanım test edilmemiştir.
- Tipik kullanım: Host yaklaşık 0.7 GB bellek ve Bot'un bilgisayarı yaklaşık 0.8 GB (en yüksek 1.7 GB) kullanır; görüntüler yaklaşık 13 GB yer kaplar.
- En basiti x86_64'tür. Bir ARM64 makinesi (örneğin Oracle A1) yalnızca Host'u çalıştırabilir, Bot'un bilgisayarı ise ikinci bir x86_64 makinesinde çalışabilir. Bot'un bilgisayarını ARM üzerinde öykünmek de çalışır ancak çok daha yavaştır ve deneyseldir. ARM kurulumları mevcut sürümle yeniden test edilmemiştir.

Ayrıca araç çağırmalı (ve Bot'un bir bilgisayarı çalıştırması gerekiyorsa görsel girişli) bir model API'sine, istemcileri derlemek için Node.js 22.12+ kurulu bir bilgisayara ve kendiniz indirdiğiniz resmî yükleyicilere ihtiyacınız vardır. Web araması, görsel üretimi, ses, anlık bildirimler ve bir HTTPS alan adı isteğe bağlıdır.

## İstemciler

<a id="client-versions"></a>
<!-- client-versions:start -->
**Hangi resmî sürümü indirmeliyim?** Sağ sütundakini; yamalar yalnızca bu sürümleri kabul eder. İki sürüm listelendiğinde önce önerilen daha yeni olanı kullanın ve yalnızca çalışmazsa eski olana geçin. Sol sütun en son resmî sürümdür (2026-11-25 tarihinde kontrol edildi); daha yeni olduğunda bu proje onu destekleyene kadar bekleyin.

| Platform | En son resmî | Bu projenin ihtiyaç duyduğu sürüm |
| --- | --- | --- |
| Windows x64 | [1.3.0](https://api2.cursor.sh/updates/api/download/stable/win32-x64-user/sand) | **1.3.0** (önerilen); çalışmazsa 1.2.3, 1.1.0, 0.71.2 |
| Linux x64 / ARM64 | [1.3.0](https://api2.cursor.sh/updates/api/download/stable/linux-x64/sand) | 1.3.0 (.deb arşivi; sanal ekranlı bir kapsayıcıda Ubuntu 24.04 x64 üzerinde test edildi; yerel masaüstleri ve ARM64 test edilmedi) |
| macOS ARM64 | [1.3.0](https://api2.cursor.sh/updates/api/download/stable/darwin-arm64/sand) | 1.3.0 (1.3.0 ile bir Apple Silicon Mac'te çalıştığı test edildi) |
| macOS Intel (x64) | [1.3.0](https://api2.cursor.sh/updates/api/download/stable/darwin-x64/sand) | 1.3.0 (1.3.0 ile bir Intel Mac'te çalıştığı test edildi) |
| iOS | [1.28.0](https://apps.apple.com/us/app/grok-bot/id6794501026) | 1.28.0 (derleme 29649; 1.28.0 ile bir iPhone'da çalıştığı test edildi) |
| Android 9+ (resmî olmayan) | Resmî Android uygulamasını kullanmaz | Uygulama **1.1.0** (derleme 10100), arayüz Windows **1.1.0** yükleyicisinden alınmıştır (önerilen; çalışmazsa 0.71.2) |
| Web istemcisi (tarayıcı, resmî olmayan) | Kurulacak bir şey yok | Arayüz Windows **1.1.0** yükleyicisinden alınmıştır (önerilen; çalışmazsa 0.71.2), bir kez derlenir ve Host'unuza yüklenir |
| Linux sunucusu | yok | Host `d0a4baa`; Bot bilgisayarı `9d2ac1b` (x86_64) |

ProkBot Plus'ın kendi sürüm numaraları vardır; bkz. [en son sürüm](https://github.com/ferretgeek/prokbot-plus/releases/latest). Yukarı akış ProkBot temeli `3e9fe8c`'dir.
<!-- client-versions:end -->

| İstemci | Gereksinimler | Notlar |
| --- | --- | --- |
| Windows | Windows 10 / 11 x64 | Plus'ta yeni. Taşınabilir sürüm veya yükleyici, yönetici hakları gerekmez. Bot bilgisayarınızda komutlar çalıştırabilir ve önce size sorar. Windows 11'de test edildi (1.2.3 ve öncesi; 1.3.0 henüz test edilmedi). |
| Linux | Linux x64 / ARM64 masaüstü | Plus'ta yeni. Taşınabilir klasör, `.tar.gz` ve kullanıcı başına kurulum betiği, root gerekmez. Tailcat, yerel komutlar ve Codex destekler; yerel fare/klavye GUI denetimi yoktur. 1.2.3, WSL2 altında Ubuntu 22.04 x64 üzerinde test edildi; 1.3.0, yerel Linux masaüstleri ve ARM64 test edilmedi. |
| Android | Android 9+, sistem WebView 89+ | Resmî Android uygulaması değil, kendi uygulamamızdır. Gerçek bir telefonda değil, Android 15 / 16 öykünücülerinde test edildi. |
| Web istemcisi | Güncel Chrome, Edge, Firefox veya Safari | Host'unuz tarafından sunulur ve telefonlara, tabletlere ve bilgisayarlara uyum sağlar; bir eşleştirme koduyla oturum açın. Yalnızca Bot'un bilgisayarıyla çalışır, asla kendi cihazınızla çalışmaz. |
| Mac | Apple Silicon veya Intel | Hem Apple Silicon hem de Intel Mac'lerde resmî 1.3.0'ı destekler (1.3.0 hem Apple Silicon hem de Intel Mac'lerde canlı test edildi; hâlâ 1.2.3'e ihtiyacınız varsa ProkBot Plus v1.15.0 Mac paketini kullanın). |
| iPhone / iPad | Kendi şifresi çözülmüş IPA'nız ve imzalama sertifikanız | 1.27.0, 1.26.0 ve 1.16.0 yedekleriyle resmî 1.28.0'ı (derleme 29649, önerilen) destekler. Katkıda bulunan kişi bir iPhone'da 1.28.0 ile eşleştirme, sohbet, ekler, ana liste kaydırma ve gerçek zamanlı ses anahtarını canlı test etti; 1.27.0 bir iPad'de yükseltme, eşleştirme, sohbet, ekler ve App Intents için canlı test edildi. |

<a id="android-client"></a><a id="web-client"></a>
**Android uygulaması**, resmî Android uygulamasını değiştirmez (kurcalamaya karşı korumalıdır). Resmî masaüstü arayüzünü bu proje tarafından yazılmış bir kabuğun içine yerleştirir. Bot'un bilgisayarını canlı izleyebilir ve kontrolü devralabilirsiniz; bildirimler Google push olmadan çalışır. APK'yı kendi anahtarınızla imzalarsınız.

**Web istemcisi**, bir bilgisayarda derlenir ve Host'unuza yüklenir. Ardından herhangi bir cihazda bir tarayıcıda web istemcisi adresini (yönetici sayfasından ayrı olarak kendi Host portu, varsayılan olarak 18081) açın ve bir eşleştirme kodu girin; ayrıca ana ekrana da ekleyebilirsiniz. Dışarıdan erişirken web istemcisi için kendi kaydıyla HTTPS kullanın. Bkz. [web istemcisi kılavuzu](web/README.en.md).

## Kurulum

En kolay yol: bunu komut çalıştırabilen bir yapay zekaya (Claude Code, Codex, Cursor ve benzerleri) gönderin:

```text
Please deploy ProkBot Plus for me: https://github.com/ferretgeek/prokbot-plus
First read docs/AI-INSTALL.en.md in the repository in full, then follow its steps exactly.
Ask about my machines, any existing instance, model and access method. Run doctor first. Never remove volumes, disclose keys or treat container startup as acceptance. Verify a two-turn client chat and a desktop action at the end.
```

Kendiniz yapmak için [dağıtım kılavuzunu](docs/AI-INSTALL.en.md) izleyin: sunucuda `doctor` → `init` → `up` → `status` komutlarını çalıştırın, ardından yönetici sayfasında modeli ayarlayıp bir eşleştirme kodu oluşturun ve bir istemciyle bağlanın.

[En son sürümde](https://github.com/ferretgeek/prokbot-plus/releases/latest) yedi araç paketi vardır: Host, Windows, Mac, Linux, iOS, Android ve web istemcisi. İhtiyacınız olanı indirin. Paketler resmî programlar içermez; istemcileri kendi bilgisayarınızda resmî yükleyicilerden derlersiniz.

## Resmî Grok Bot ile karşılaştırma

**Avantajlar**: modelleri ve sağlayıcıları siz seçersiniz; verileriniz sizde kalır ve yalnızca yerel ağda kullanım çalışır; ayrıca sistem istemini düzenleme, kullanım istatistikleri, webhook'lar, kendi uygulamalarınız ve yedekleme ile geri yükleme gibi birkaç ekstra özellik vardır.

**Maliyetler**:

- bir Linux sunucusunu kendiniz yönetirsiniz;
- istemci sürümleri sabitlenmiştir: yeni bir resmî sürümün önce uyarlanması gerekir ve otomatik güncelleme yoktur;
- sonuçlar seçtiğiniz modele bağlıdır;
- bazı resmî özellikler kapalıdır (sanal kartlar, harici mesaj taslakları, geçiş anahtarı yönlendirme) ve ses, anlık bildirim ve görsel üretimi kendi sağlayıcılarınızı gerektirir;
- resmî web sitesinde paylaşılan Botlar (x.ai/bot/… sayfalarındaki "Add to Grok Bot") eklenemez, çünkü bu şablonlar resmî bulutta bulunur; Botlar Host'lar arasında ZIP dosyaları olarak paylaşılır;
- istemciler kodla imzalanmamıştır: Windows bir SmartScreen uyarısı gösterir, iPhone uygulamasını kendiniz imzalarsınız ve Android bilinmeyen kaynaklardan yüklemeye izin verilmesini gerektirir;
- Windows ve Linux'ta Bot komut çalıştırabilir ancak henüz fare ve klavyeyi kontrol edemez;
- resmî istemcileri yamalamak resmî kullanım koşullarını ihlal edebilir; bunu kendi sorumluluğunuzda yaparsınız.

## Belgeler

| Belge | İçerik |
| --- | --- |
| [Dağıtım kılavuzu](docs/AI-INSTALL.en.md) | Dağıtım, modeller, istemci derleme, işlemler, yedekleme ve geri yükleme, sorun giderme |
| [Mimari](docs/ARCHITECTURE.en.md) | Nasıl çalışır, Plus neleri değiştirir, düzen, testler, bakım ve sürümler, bilinen sınırlar |
| [Linux istemcisi kılavuzu](linux/README.en.md) | Linux (x64 / ARM64) için derleme, taşınabilir başlatma, root'suz kurulum ve AppArmor korumalı alanı |
| [Web istemcisi kılavuzu](web/README.en.md) | Web istemcisini derleme, yükleme ve oturum açma; tarayıcı desteği |
| [Değişiklik günlüğü](CHANGELOG.md) | Her sürümde nelerin değiştiği |

Her platformun kendi araç paketiyle birlikte gelen `host/`, `windows/`, `mac/`, `linux/`, `android/`, `web/` ve `ios/` altında kendi README dosyası vardır.

## Topluluk

- Tartışma ve sürüm duyuruları [LINUX DO](https://linux.do) üzerindedir;
- hataları [issue](https://github.com/ferretgeek/prokbot-plus/issues) olarak, güvenlik sorunlarını ise [SECURITY.md](SECURITY.md) dosyasında açıklandığı şekilde özel olarak bildirin;
- katkıda bulunmak için bkz. [CONTRIBUTING.md](CONTRIBUTING.md).

<a id="license-and-notices"></a>
## Lisans ve bildirimler

- [ProkBot](https://gitee.com/ahaduoduoduo/ProkBot) projesinden (`3e9fe8c` commit'i) türetilmiştir ve onun [ProkBot Ticari Olmayan Lisans 1.0](LICENSE) lisansı altındadır: kişisel kullanım, inceleme, değiştirme ve ticari olmayan dağıtıma izin verilir; ücretli dağıtım, ücretli hizmetler ve şirket içi ticari kullanım dâhil her türlü ticari kullanım yasaktır. Kökenler ve değişiklik listesi [NOTICE](NOTICE) dosyasındadır.
- Depo ve sürümler hiçbir resmî Grok Bot programı ve hiçbir yamalı istemci, APK, IPA veya web istemcisi paketi içermez; `android/dist/` yalnızca bu projenin kendi kabuğunu tutar.
- Grok, Grok Bot ve ilgili markalar kendi sahiplerine aittir. Bu proje onlarla bağlantılı değildir.
- Kodun çoğu yapay zeka yardımıyla yazılmıştır. 6.2Astra ve Opus5.5 tarafından birlikte sürdürülmektedir, herhangi bir garanti olmaksızın olduğu gibi sunulmaktadır.

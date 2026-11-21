import type { appEn } from "./app.en";

// Turkish messages of the main window, About, updates and shared helpers.
// Every English key needs a Turkish message (checked by tsc).
export const appTr: Record<keyof typeof appEn, string> = {
  "app.language.title": "Dil",
  "app.language.system": "Sistem varsayılanı",
  "app.language.en": "English",
  "app.language.tr": "Türkçe",
  "app.language.failed": "Dil değiştirilemedi.",

  "app.subtitle": "Ekran yakalama ve not ekleme",
  "app.capture.section": "Yakala",
  "app.capture.button": "Alanı Yakala",
  "app.capture.shortcutLabel": "Kısayol {shortcut}",
  "app.capture.hint":
    "Tüm ekranları dondurur. Alan seçmek için sürükleyin, iptal etmek için {esc} tuşuna basın.",
  "app.record.button": "Alan Kaydı Başlat",
  "app.record.hint":
    "Seçilen alanı MP4 video olarak kaydeder. Menü çubuğundan{shortcut} durdurabilirsiniz.",
  "app.record.orShortcut": " veya {shortcut} ile",
  "app.features.label": "Özellikler",
  "app.features.capture.title": "Yakala",
  "app.features.capture.text": "Ekranın istediğiniz alanını seçin.",
  "app.features.annotate.title": "Not Ekle",
  "app.features.annotate.text": "Ok, dikdörtgen ve metin ekleyin.",
  "app.features.export.title": "Dışa Aktar",
  "app.features.export.text": "Panoya kopyalayın veya PNG olarak kaydedin.",
  "app.status.label": "Durum",
  "app.status.runsInMenuBar": "Menü çubuğunda çalışır",
  "app.status.runsInSystemTray": "Sistem tepsisinde çalışır",
  "app.status.running": "Çalışıyor",
  "app.status.keepsRunning": "Bu pencereyi kapatmak Snipvero'yu çalışır durumda tutar.",
  "app.permission.title": "Ekran Kaydı",
  "app.permission.checking": "Denetleniyor…",
  "app.permission.notAvailable": "Kullanılamıyor",
  "app.permission.allowed": "İzin verildi",
  "app.permission.notAllowed": "İzin verilmedi",
  "app.permission.help":
    "Sistem Ayarları → Gizlilik ve Güvenlik → Ekran ve Sistem Ses Kaydı bölümünde Snipvero'yu açın. Yakalama yine de başarısız olursa Snipvero'yu yeniden başlatın.",
  "app.permission.openSettings": "Sistem Ayarları'nı Aç",
  "app.permission.restart": "Snipvero'yu Yeniden Başlat",
  "app.permission.unsupported": "Ekran yakalama bu platformda henüz kullanılamıyor.",
  "app.footer.version": "Sürüm {version}",
  "app.footer.about": "Snipvero Hakkında",

  "app.shortcut.title": "Genel kısayol",
  "app.shortcut.recording": "Kısayol bekleniyor…",
  "app.shortcut.unavailable": "Kullanılamıyor",
  "app.shortcut.cancel": "İptal",
  "app.shortcut.change": "Değiştir…",
  "app.shortcut.prompt": "Yeni kısayola basın veya iptal etmek için {esc} tuşuna basın.",
  "app.shortcut.noReason": "neden belirtilmedi",
  "app.shortcut.notRegisteredMenuBar":
    " kaydedilemedi, büyük olasılıkla başka bir uygulama kullandığı için ({reason}). Başka bir kısayol seçin veya menü çubuğundaki {capture} öğesini kullanın.",
  "app.shortcut.notRegisteredSystemTray":
    " kaydedilemedi, büyük olasılıkla başka bir uygulama kullandığı için ({reason}). Başka bir kısayol seçin veya sistem tepsisindeki {capture} öğesini kullanın.",
  "app.shortcut.trayCapture": "Yakala",
  "app.shortcut.reset": "{shortcut} olarak sıfırla",
  "app.shortcut.example.macos": "⌘⇧ veya ⌃⌥",
  "app.shortcut.example.other": "Ctrl+Shift veya Ctrl+Alt",
  "app.shortcut.rejection.modifiers":
    "Diğer uygulamalar kendi kısayollarını koruyabilsin diye {example} gibi iki düzenleyici tuş kullanın. İşlev tuşuyla (F1–F24) bir tane yeterlidir. Print Screen tek başına kullanılabilir.",
  "app.shortcut.rejection.modifiersF13":
    " Bazı Mac klavyeler Print Screen'i F13 olarak bildirdiği için F13 de tek başına kullanılabilir.",
  "app.shortcut.rejection.reserved":
    "Bu tuş birleşimi sistem veya çoğu uygulama tarafından kullanılıyor. Başka bir tane seçin.",
  "app.shortcut.rejection.unavailable":
    "Bu tuş birleşimi kaydedilemedi, büyük olasılıkla başka bir uygulama kullandığı için.",
  "app.shortcut.rejection.notSaved":
    "Kısayol kaydedilemedi. Önceki kısayol çalışmaya devam ediyor.",
  "app.shortcut.rejection.invalid": "Bu tuş kısayolda kullanılamaz. Başka bir tane seçin.",

  "app.about.description":
    "macOS için hafif, açık kaynaklı bir ekran görüntüsü ve not ekleme uygulaması.",
  "app.about.version": "Sürüm {version}",
  "app.about.developer": "Geliştirici",
  "app.about.website": "Web Sitesi",
  "app.about.contact": "İletişim",
  "app.about.sourceCode": "Kaynak Kodu",
  "app.about.contributors": "Katkıda Bulunanlar",
  "app.about.viewOnGitHub": "GitHub'da Görüntüle",
  "app.about.license": "Lisans",
  "app.about.licenseName": "MIT Lisansı",
  "app.about.viewLicense": "Görüntüle",

  "app.update.title": "Güncellemeler",
  "app.update.privacy":
    "Yalnızca siz tıkladığınızda GitHub'a bakılır. Hiçbir ekran görüntüsü veya kişisel veri gönderilmez.",
  "app.update.restartNote":
    "Snipvero güncellemeyi indirecek, ardından kurulumu tamamlamak için kapanıp yeniden açılacak. Önce açık yakalamayı kapatın.",
  "app.update.check": "Güncellemeleri Denetle…",
  "app.update.checking": "Denetleniyor…",
  "app.update.checkAgain": "Yeniden Denetle",
  "app.update.upToDate": "Snipvero {current} güncel.",
  "app.update.available": "Snipvero {version} kullanıma sunuldu.",
  "app.update.youHave": "Sizdeki sürüm: {current}.",
  "app.update.releaseNotes": "Sürüm notları",
  "app.update.download": "İndir ve Yeniden Başlat",
  "app.update.notNow": "Şimdi Değil",
  "app.update.progress": "İndirme ilerlemesi",
  "app.update.downloading": "Snipvero {version} indiriliyor… {received}",
  "app.update.downloadingOf": "Snipvero {version} indiriliyor… {received} / {total}",
  "app.update.cancel": "İptal",
  "app.update.installing": "Snipvero {version} kuruluyor… Birazdan yeniden başlatılacak.",
  "app.update.restarting": "Snipvero yeniden başlatılıyor…",
  "app.update.keepsWorking": "Snipvero {current} çalışmaya devam ediyor.",
  "app.update.tryAgain": "Tekrar Dene",
  "app.update.failure.unavailable": "Güncellemeler bu sürümde kullanılamıyor.",
  "app.update.failure.network":
    "Snipvero güncelleme sunucusuna ulaşamadı. İnternet bağlantınızı denetleyip tekrar deneyin.",
  "app.update.failure.manifest": "Güncelleme bilgisi okunamadı.",
  "app.update.failure.noBuild": "Bu güncelleme Mac'iniz için kullanılamıyor.",
  "app.update.failure.verification": "Güncelleme doğrulanamadığı için kurulmadı.",
  "app.update.failure.location":
    "Snipvero'yu Uygulamalar klasörüne taşıyın, buradan açın ve tekrar deneyin.",
  "app.update.failure.busy": "Geçerli yakalamayı bitirin veya iptal edin, ardından tekrar deneyin.",
  "app.update.failure.install": "Güncelleme kurulamadı.",
  "app.update.failure.cancelled": "İndirme iptal edildi.",
  "app.update.failure.inProgress":
    "Bir güncelleme zaten başka bir Snipvero penceresinde indiriliyor.",
  "app.update.failure.failed": "Güncellenirken bir sorun oluştu.",
};

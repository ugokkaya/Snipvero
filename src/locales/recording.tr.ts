import type { recordingEn } from "./recording.en";

// Turkish messages of the recording views. Every English key needs a Turkish message (checked by tsc).
export const recordingTr: Record<keyof typeof recordingEn, string> = {
  "recording.actionFailed": "İşlem başarısız oldu.",
  "recording.exportFailed": "Dışa aktarma başarısız oldu.",

  "recording.review.inProgress": "Kayıt sürüyor. Menü çubuğundan durdurun.",
  "recording.review.none": "İncelenecek bir kayıt yok.",
  "recording.review.title": "Kayıt",
  "recording.review.previewFailed": "Önizleme oynatılamadı. Yine de kaydedebilirsiniz.",
  "recording.review.size": "Boyut",
  "recording.review.length": "Süre",
  "recording.review.sound": "Ses",
  "recording.review.file": "Dosya",
  "recording.review.save": "Kaydet…",
  "recording.review.copyFile": "Dosyayı Kopyala",
  "recording.review.fileCopied": "Dosya kopyalandı.",
  "recording.review.copyPath": "Yolu Kopyala",
  "recording.review.pathCopied": "Yol kopyalandı.",
  "recording.review.exportGif": "GIF Olarak Dışa Aktar…",
  "recording.review.discard": "At",
  "recording.review.hint":
    "Kayıt geçici bir dosyadır. Kaydın ve yolunun kopyaları yalnızca siz kaydedene, atana veya Snipvero'dan çıkana kadar geçerlidir.",

  "recording.gif.title": "GIF Olarak Dışa Aktar",
  "recording.gif.frameRate": "Kare hızı",
  "recording.gif.width": "Genişlik",
  "recording.gif.progress": "GIF dışa aktarma ilerlemesi",
  "recording.gif.choosing": "Kaydedileceği yeri seçin…",
  "recording.gif.cancelling": "İptal ediliyor…",
  "recording.gif.cancelExport": "Dışa Aktarmayı İptal Et",
  "recording.gif.export": "Dışa Aktar…",
  "recording.gif.close": "Kapat",
  "recording.gif.cancelled": "GIF dışa aktarma iptal edildi.",
  "recording.gif.savedOne": "GIF kaydedildi ({size}, {frames} kare).",
  "recording.gif.savedMany": "GIF kaydedildi ({size}, {frames} kare).",
  "recording.gif.estimate": "en fazla yaklaşık {size}",

  "recording.audio.legend": "Ses",
  "recording.audio.system": "Sistem sesi",
  "recording.audio.microphone": "Mikrofon",
  "recording.audio.both": "Sistem sesi ve mikrofon",
  "recording.audio.none": "Yok",
  "recording.audio.hint":
    "Siz açmadıkça ses kapalıdır. Mikrofonu ilk kez açtığınızda macOS izin ister.",
  "recording.audio.restricted":
    "Bu Mac'te mikrofon erişimi kısıtlanmış (örneğin bir profil tarafından), bu yüzden Snipvero mikrofonu kaydedemez.",
  "recording.audio.denied":
    "Snipvero için mikrofon erişimi kapalı. Sistem Ayarları → Gizlilik ve Güvenlik → Mikrofon bölümünden açın, ardından mikrofonu burada tekrar açın.",
  "recording.audio.openSettings": "Sistem Ayarları'nı Aç",
};

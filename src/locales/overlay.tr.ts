import type { overlayEn } from "./overlay.en";

// Turkish messages of the overlay views. Every English key needs a Turkish message (checked by tsc).
export const overlayTr: Record<keyof typeof overlayEn, string> = {
  "overlay.tool.select": "Seç ve taşı",
  "overlay.tool.arrow": "Ok",
  "overlay.tool.rect": "Dikdörtgen",
  "overlay.tool.text": "Metin",
  "overlay.tool.fill": "Doldur (alanı kapat)",
  "overlay.tool.blur": "Bulanıklaştır (alanı piksellere böl)",
  "overlay.tool.highlight": "Vurgula",
  "overlay.size.small": "İnce çizgi ve küçük metin",
  "overlay.size.medium": "Orta çizgi ve orta metin",
  "overlay.size.large": "Kalın çizgi ve büyük metin",
  "overlay.color": "Renk {color}",
  "overlay.undo": "Geri Al ({key})",
  "overlay.redo": "Yinele ({key})",
  "overlay.delete": "Seçili ek açıklamayı sil (Delete)",
  "overlay.delayed": "Bu bölgeyi 5 saniye sonra yeniden yakala (ek açıklamalar silinir)",
  "overlay.copy": "Panoya kopyala ({key})",
  "overlay.save": "PNG olarak kaydet ({key})",
  "overlay.record.tooltip": "Bu bölgeyi video olarak kaydet (ek açıklamalar kaydedilmez)",
  "overlay.record.label": "Bu bölgeyi video olarak kaydet",
  "overlay.record.button": "Kayıt",
  "overlay.keys.copy": "{key} veya Enter",
  "overlay.microphoneNotice":
    "Mikrofon açık, ancak Snipvero'nun kullanmasına izin verilmemiş. Sistem Ayarları → Gizlilik ve Güvenlik → Mikrofon bölümünden izin verin veya mikrofonsuz kaydedin.",
  "overlay.recordWithoutMicrophone": "Mikrofonsuz kaydet",
  "overlay.hint.record": "Kaydedilecek alanı seçmek için sürükleyin · İptal için Esc",
  "overlay.hint.capture": "Seçmek için sürükleyin · İptal için Esc",
  "overlay.textEditor": "Ek açıklama metni",
  "overlay.exportFailed": "Dışa aktarma başarısız oldu.",
};

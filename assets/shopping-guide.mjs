// Local shopping guidance without AI calls or live stock access.
export function offlineReply(messages, lang) {
  const english = lang === 'en';
  const latest = messages.at(-1)?.content.toLowerCase() || '';
  const previous = messages.slice(0, -1).filter(m => m.role === 'user').slice(-2).map(m => m.content).join(' ').toLowerCase();
  const text = latest.length < 45 && /^(iya|ya|terus|lanjut|gimana|bagaimana|itu|yes|then|how|what next)\b/.test(latest) ? `${previous} ${latest}` : latest;
  const choose = (id, en) => english ? en : id;
  if (/password|otp|pin\b|kata sandi|aman|percaya|penipu|trust|safe|scam|garansi|refund/.test(text)) {
    return choose('Sebelum bayar, periksa detail produk, nominal QRIS, dan simpan invoice serta bukti pembayaran. Jangan bagikan password akun pribadi, OTP, atau PIN. Pembelian akun memiliki risiko; konfirmasi ketentuan garansi pada detail listing atau CS Telegram @Bloxnovaa. Aku tidak bisa menjamin transaksi 100% aman atau menjanjikan refund.', 'Before paying, check the product details and QRIS amount, then keep your invoice and payment receipt. Never share your personal account password, OTP or PIN. Account purchases carry risks; confirm listing-specific warranty terms with Telegram support @Bloxnovaa. I cannot guarantee zero risk or promise refunds.');
  }
  if (/pesanan|invoice|bnx-|belum masuk|ditolak|transaksi|order|rejected|arrived|status|sudah bayar|udah bayar/.test(text)) {
    return choose('Buka “Cek Transaksi” dengan nomor invoice BNX-… atau “Pesananku” di perangkat saat membeli. Jika sudah bayar, pastikan bukti dikirim lewat tab “Kirim Bukti”. Aku tidak dapat melihat status pembayaran pribadi. Jika tertunda atau ditolak, hubungi CS Telegram @Bloxnovaa dengan invoice; jangan bayar ulang dulu.', 'Open “Cek Transaksi” with your BNX-… invoice, or “Pesananku” on the device you used to buy. If you paid, submit the receipt through “Kirim Bukti”. I cannot see private payment status. For delays or rejection, contact Telegram @Bloxnovaa with the invoice; avoid paying again first.');
  }
  if (/qris|dana|gopay|ovo|bayar|payment|pay\b|scan/.test(text)) {
    return choose('QRIS bisa dibayar lewat DANA, GoPay, OVO, ShopeePay, atau m-banking. Buka checkout, periksa nominal, lalu scan QRIS dari aplikasi pembayaran. Setelah berhasil, buka tab “Kirim Bukti”, isi nama pengirim dan unggah screenshot. Jika QRIS gagal dimuat atau saldo terpotong tanpa kepastian, hubungi CS Telegram @Bloxnovaa sebelum mengulang pembayaran.', 'Pay the checkout QRIS using DANA, GoPay, OVO, ShopeePay or mobile banking. Check the amount before scanning. After payment, open “Kirim Bukti”, enter the sender name and upload the receipt. If QRIS fails to load or your balance is deducted without confirmation, contact Telegram @Bloxnovaa before paying again.');
  }
  if (/akun|account|adopt|blox fruit|brainrot|pet|stok|stock/.test(text)) {
    return choose('Buka menu “Jual Akun”, pilih game, lalu cek harga, foto, dan isi akun pada detail listing. Stok terbaru belum bisa kupastikan di mode panduan ini. Setelah cocok, isi kontak dan pilih “Beli akun ini”. Data login tampil setelah persetujuan admin; segera ganti password dan email. Game dan budget berapa yang kamu cari?', 'Open “Jual Akun”, choose a game, and check each listing’s price, photos and included items. Live stock is unavailable in guide mode. Enter your contact and select “Beli akun ini” when ready. Login details appear after admin approval; change the password and email immediately. Which game and budget are you looking for?');
  }
  if (/robux|top.?up|paket|budget|harga|murah|\d+\s*(rb|ribu|k)|price/.test(text)) {
    return choose('Paket pilihan: 411 Robux Rp25.000; 854 Rp50.000; 1.773 Rp100.000; 3.673 Rp200.000. Kustom memakai kurs berbeda, Rp60/Robux dengan minimum Rp25.000. Untuk beli, isi username, tekan SCAN, pilih jenis akun dan paket, lalu lanjut checkout. Cukup username tanpa password. Berapa budget atau target Robux kamu?', 'Preset packs: 411 Robux Rp25,000; 854 Rp50,000; 1,773 Rp100,000; 3,673 Rp200,000. Custom orders use a separate Rp60/Robux rate with a Rp25,000 minimum. Enter your username, select SCAN, account type and pack, then checkout. No password needed. What is your budget or Robux target?');
  }
  return choose('Aku bisa membantu memilih paket Robux, mencari akun, menjelaskan QRIS, atau mengarahkan pengecekan pesanan. Panduan otomatis ini menjawab pertanyaan umum. Untuk bantuan langsung, hubungi CS Telegram @Bloxnovaa.', 'I can guide you through Robux packs, account shopping, QRIS and order checks. This automatic guide covers common questions. For direct help, contact Telegram support @Bloxnovaa.');
}

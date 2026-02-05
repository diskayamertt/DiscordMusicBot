# Discord Müzik Botu

Discord sunucuları için YouTube müzik botu.

## Özellikler

- YouTube URL'lerinden müzik çalma
- Şarkı ismi ile arama ve çalma
- Müzik kuyruğu yönetimi
- Tekrar çalma, geçme ve durdurma butonları
- Otomatik sıradaki şarkıya geçme
- Discord.js v14 ve güncel @discordjs/voice uyumluluğu

## Komutlar

- `.play [şarkı adı/URL]`: Şarkı çalar veya kuyruğa ekler
- `.next`: Sıradaki şarkıya geçer
- `.stop`: Müziği durdurur ve botu ses kanalından çıkarır
- `.kuyruk`: Çalan şarkı + kuyruktaki şarkıları gösterir
- `.clear`: Kuyruğu temizler

## Kurulum

1. Repoyu klonlayın:

```bash
git clone [repo-url]
```

2. Bağımlılıkları yükleyin:

```bash
npm install
```

3. `.env` dosyası oluşturun ve Discord bot token'ınızı ekleyin:

```env
DISCORD_TOKEN=your_token_here
```

4. Botu başlatın:

```bash
npm start
```

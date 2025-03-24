require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { createAudioPlayer, createAudioResource, joinVoiceChannel, NoSubscriberBehavior } = require('@discordjs/voice');
const youtubeDl = require('youtube-dl-exec');
const play = require('play-dl');

// Token'ı .env dosyasından al
const TOKEN = process.env.DISCORD_TOKEN;

// Discord client oluştur
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ]
});

// Üst kısma queue yönetimi için global değişkenler ekleyelim
const queues = new Map();

// Queue yönetimi için yardımcı fonksiyonlar
class MusicQueue {
  constructor() {
    this.songs = [];
    this.playing = false;
    this.connection = null;
    this.player = null;
  }

  addSong(song) {
    this.songs.push(song);
  }

  clear() {
    this.songs = [];
  }

  getNext() {
    return this.songs.shift();
  }

  isEmpty() {
    return this.songs.length === 0;
  }

  // Yeni metod: Çalma durumunu sıfırla
  reset() {
    this.playing = false;
    if (this.player) {
      this.player.stop();
      this.player = null;
    }
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
  }
}

// YouTube'dan ses akışı başlat
async function playYouTubeAudio(voiceConnection, url) {
  try {
    console.log(`[DEBUG] YouTube ses akışı başlatılıyor: ${url}`);

    const stream = youtubeDl.exec(
      url,
      {
        output: '-',
        quiet: true,
        format: 'bestaudio',
        limitRate: '1M'
      },
      { stdio: ['ignore', 'pipe', 'ignore'] }
    ).stdout;

    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play
      }
    });

    const resource = createAudioResource(stream, {
      inputType: 'arbitrary',
      inlineVolume: true
    });

    resource.volume?.setVolume(1);
    voiceConnection.subscribe(player);
    player.play(resource);

    // Debug için event listener'lar
    player.on('stateChange', (oldState, newState) => {
      console.log(`[DEBUG] Player durumu: ${newState.status}`);
    });

    player.on('error', error => {
      console.error('[DEBUG] Player hatası:', error);
    });

    return player;
  } catch (error) {
    console.error('[DEBUG] Ses akışı hatası:', error);
    throw error;
  }
}

// Yeni fonksiyon: YouTube'da arama yap
async function searchYoutube(query) {
  try {
    const searchResults = await play.search(query, {
      limit: 1
    });
    
    if (searchResults && searchResults.length > 0) {
      return searchResults[0].url;
    }
    return null;
  } catch (error) {
    console.error('Arama hatası:', error);
    return null;
  }
}

// Bot hazır olduğunda
client.once('ready', () => {
  console.log(`Bot hazır: ${client.user.tag}`);
});

// Yeni bir fonksiyon ekleyelim - kontrol butonları oluşturmak için
function createMusicControlButtons() {
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('replay')
        .setLabel('🔄 Tekrar Çal')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('stop')
        .setLabel('⏹ Durdur')
        .setStyle(ButtonStyle.Danger)
    );
  return row;
}

// Şarkı çalma fonksiyonunu güncelleyelim
async function playNext(guildId, message) {
  const queue = queues.get(guildId);
  if (!queue || queue.isEmpty()) {
    message.channel.send('📭 Kuyrukta başka şarkı kalmadı!');
    queue.playing = false; // Çalma durumunu güncelle
    return;
  }

  const nextSong = queue.getNext();
  try {
    // Player'ı queue'ya kaydedelim
    queue.player = await playYouTubeAudio(queue.connection, nextSong.url);
    
    const controlButtons = createMusicControlButtons();
    const reply = await message.channel.send({
      content: `🎵 Şimdi çalıyor: ${nextSong.title}`,
      components: [controlButtons]
    });

    // Player event listener'ı ekleyelim
    queue.player.on('stateChange', (oldState, newState) => {
      if (newState.status === 'idle') {
        // Şarkı bittiğinde sıradakini çal
        playNext(guildId, message);
      }
    });

    // Buton tıklamalarını dinle
    const collector = reply.createMessageComponentCollector({ time: 3600000 }); // 1 saat

    collector.on('collect', async interaction => {
      if (!interaction.member.voice.channel) {
        return interaction.reply({ content: 'Bir ses kanalında olmalısınız!', ephemeral: true });
      }

      if (interaction.customId === 'replay') {
        try {
          await playYouTubeAudio(queue.connection, nextSong.url);
          await interaction.reply({ content: '🔄 Müzik yeniden başlatıldı!', ephemeral: true });
        } catch (error) {
          await interaction.reply({ content: 'Yeniden başlatma sırasında bir hata oluştu!', ephemeral: true });
        }
      }

      if (interaction.customId === 'stop') {
        try {
          queue.connection.destroy();
          await interaction.reply({ content: '⏹ Müzik durduruldu!', ephemeral: true });
          collector.stop();
        } catch (error) {
          await interaction.reply({ content: 'Durdurma sırasında bir hata oluştu!', ephemeral: true });
        }
      }
    });

    // Collector süresi dolduğunda butonları devre dışı bırak
    collector.on('end', () => {
      const disabledButtons = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('replay')
            .setLabel('🔄 Tekrar Çal')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId('stop')
            .setLabel('⏹ Durdur')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(true)
        );
      reply.edit({ components: [disabledButtons] }).catch(console.error);
    });

  } catch (error) {
    console.error('Şarkı çalma hatası:', error);
    message.channel.send('❌ Şarkı çalınırken bir hata oluştu!');
    // Hata durumunda da sıradakine geç
    setTimeout(() => playNext(guildId, message), 1000);
  }
}

// Mesaj komutlarını dinle kısmını güncelleyelim
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  if (message.content.startsWith('.play')) {
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply('Bir ses kanalında olmalısınız!');
    }

    const args = message.content.split(' ');
    if (args.length < 2) {
      return message.reply('Lütfen bir şarkı adı veya YouTube URL\'si girin!');
    }

    const query = args.slice(1).join(' ');
    let url = query;
    let title = query;

    try {
      if (!query.startsWith('http')) {
        const searchMessage = await message.reply('🔎 Şarkı aranıyor...');
        const searchResult = await play.search(query, { limit: 1 });
        await searchMessage.delete();

        if (!searchResult || searchResult.length === 0) {
          return message.reply('❌ Şarkı bulunamadı!');
        }

        url = searchResult[0].url;
        title = searchResult[0].title;
      }

      // Queue oluştur veya mevcut olanı al
      let queue = queues.get(message.guild.id);
      if (!queue) {
        queue = new MusicQueue();
        queues.set(message.guild.id, queue);
      }

      // Şarkıyı kuyruğa ekle
      queue.addSong({ url, title });

      // Eğer çalan şarkı yoksa başlat
      if (!queue.playing) {
        queue.playing = true;
        queue.connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: voiceChannel.guild.id,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        });
        await playNext(message.guild.id, message);
      } else {
        message.reply(`📝 Kuyruğa eklendi: ${title}`);
      }

    } catch (error) {
      console.error('[DEBUG] Genel hata:', error);
      message.reply(`Bir hata oluştu: ${error.message}`);
    }
  }

  // Kuyruk komutunu ekleyelim
  if (message.content === '.kuyruk') {
    const queue = queues.get(message.guild.id);
    if (!queue || queue.isEmpty()) {
      return message.reply('📭 Kuyrukta şarkı yok!');
    }

    const songList = queue.songs.map((song, index) => 
      `${index + 1}. ${song.title}`
    ).join('\n');

    message.reply(`📋 Şarkı Kuyruğu:\n${songList}`);
  }

  // Next komutunu ekleyelim
  if (message.content === '.next') {
    const queue = queues.get(message.guild.id);
    if (!queue || !queue.playing) {
      return message.reply('▶️ Şu anda çalan bir şarkı yok!');
    }

    message.reply('⏭️ Sıradaki şarkıya geçiliyor...');
    await playNext(message.guild.id, message);
  }

  // Clear komutunu ekleyelim
  if (message.content === '.clear') {
    const queue = queues.get(message.guild.id);
    if (queue) {
      queue.clear();
      message.reply('🧹 Kuyruk temizlendi!');
    }
  }

  // Stop komutunu da güncelleyelim
  if (message.content === '.stop') {
    const queue = queues.get(message.guild.id);
    if (queue) {
      queue.reset(); // Yeni reset metodunu kullan
      message.reply('⏹ Müzik durduruldu!');
    }
  }
});

// Botu başlat
client.login(TOKEN);

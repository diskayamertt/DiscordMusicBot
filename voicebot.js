require('dotenv').config();
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
} = require('discord.js');
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} = require('@discordjs/voice');
const play = require('play-dl');

const TOKEN = process.env.DISCORD_TOKEN;
const COMMAND_PREFIX = '.';

if (!TOKEN) {
  console.error('DISCORD_TOKEN bulunamadı. Lütfen .env dosyasını kontrol edin.');
  process.exit(1);
}

class MusicQueue {
  constructor() {
    this.songs = [];
    this.connection = null;
    this.player = null;
    this.currentSong = null;
    this.textChannel = null;

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    this.player.on('error', (error) => {
      console.error('Player hatası:', error);
      this.textChannel?.send('❌ Oynatıcıda bir hata oluştu, sıradaki şarkıya geçiliyor.').catch(() => {});
      this.playNext().catch((nextError) => {
        console.error('Hata sonrası sıradaki şarkıya geçilemedi:', nextError);
      });
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.playNext().catch((error) => {
        console.error('Sıradaki şarkıya geçiş hatası:', error);
      });
    });
  }

  addSong(song) {
    this.songs.push(song);
  }

  clearSongs() {
    this.songs = [];
  }

  async connect(voiceChannel) {
    if (this.connection && this.connection.joinConfig.channelId === voiceChannel.id) {
      return;
    }

    if (this.connection) {
      this.connection.destroy();
    }

    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    this.connection.subscribe(this.player);
  }

  async playSong(song) {
    const stream = await play.stream(song.url, {
      quality: 2,
      discordPlayerCompatibility: true,
    });

    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      inlineVolume: true,
    });

    resource.volume?.setVolume(0.5);
    this.currentSong = song;
    this.player.play(resource);

    return song;
  }

  async playNext() {
    const nextSong = this.songs.shift();

    if (!nextSong) {
      this.currentSong = null;
      this.player.stop(true);
      this.textChannel?.send('📭 Kuyrukta başka şarkı kalmadı!').catch(() => {});
      return;
    }

    try {
      await this.playSong(nextSong);
      const controlButtons = createMusicControlButtons();

      await this.textChannel?.send({
        content: `🎵 Şimdi çalıyor: ${nextSong.title}`,
        components: [controlButtons],
      });
    } catch (error) {
      console.error('Şarkı çalma hatası:', error);
      this.textChannel?.send(`❌ "${nextSong.title}" çalınamadı, sıradaki deneniyor.`).catch(() => {});
      await this.playNext();
    }
  }

  async skip() {
    if (!this.currentSong) {
      return false;
    }

    this.player.stop();
    return true;
  }

  stopAll() {
    this.clearSongs();
    this.currentSong = null;
    this.player.stop(true);

    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const queues = new Map();

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, new MusicQueue());
  }

  return queues.get(guildId);
}

function createMusicControlButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('replay').setLabel('🔄 Tekrar Çal').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('skip').setLabel('⏭ Geç').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('stop').setLabel('⏹ Durdur').setStyle(ButtonStyle.Danger)
  );
}

async function resolveSong(query) {
  if (play.yt_validate(query) === 'video') {
    const info = await play.video_basic_info(query);
    return { url: info.video_details.url, title: info.video_details.title };
  }

  const results = await play.search(query, { limit: 1, source: { youtube: 'video' } });
  if (!results.length) {
    return null;
  }

  return { url: results[0].url, title: results[0].title };
}

function isInSameVoiceChannel(message, queue) {
  const userVoiceChannelId = message.member?.voice?.channelId;
  const botVoiceChannelId = queue.connection?.joinConfig?.channelId;

  if (!botVoiceChannelId) {
    return true;
  }

  return userVoiceChannelId === botVoiceChannelId;
}

client.once('ready', () => {
  console.log(`Bot hazır: ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) {
    return;
  }

  const queue = queues.get(interaction.guildId);
  if (!queue) {
    return interaction.reply({ content: 'Aktif bir müzik kuyruğu yok.', ephemeral: true });
  }

  const memberVoiceChannel = interaction.member?.voice?.channelId;
  if (!memberVoiceChannel || memberVoiceChannel !== queue.connection?.joinConfig?.channelId) {
    return interaction.reply({ content: 'Bu butonu kullanmak için aynı ses kanalında olmalısınız.', ephemeral: true });
  }

  try {
    if (interaction.customId === 'replay') {
      if (!queue.currentSong) {
        return interaction.reply({ content: 'Şu anda tekrar başlatılacak şarkı yok.', ephemeral: true });
      }

      await queue.playSong(queue.currentSong);
      return interaction.reply({ content: '🔄 Şarkı yeniden başlatıldı.', ephemeral: true });
    }

    if (interaction.customId === 'skip') {
      const skipped = await queue.skip();
      return interaction.reply({ content: skipped ? '⏭ Şarkı geçildi.' : 'Geçilecek aktif şarkı yok.', ephemeral: true });
    }

    if (interaction.customId === 'stop') {
      queue.stopAll();
      queues.delete(interaction.guildId);
      return interaction.reply({ content: '⏹ Müzik durduruldu ve kuyruk temizlendi.', ephemeral: true });
    }
  } catch (error) {
    console.error('Buton etkileşim hatası:', error);
    return interaction.reply({ content: 'İşlem sırasında bir hata oluştu.', ephemeral: true });
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(COMMAND_PREFIX)) {
    return;
  }

  const [command, ...args] = message.content.trim().split(/\s+/);
  const queue = getQueue(message.guild.id);

  if (command === '.play') {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      return message.reply('Bir ses kanalında olmalısınız!');
    }

    if (!isInSameVoiceChannel(message, queue)) {
      return message.reply('Botu kontrol etmek için botla aynı ses kanalında olmalısınız.');
    }

    if (!args.length) {
      return message.reply('Lütfen bir şarkı adı veya YouTube URL\'si girin!');
    }

    const query = args.join(' ');
    const searchingMessage = await message.reply('🔎 Şarkı aranıyor...');

    try {
      queue.textChannel = message.channel;
      await queue.connect(voiceChannel);

      const song = await resolveSong(query);
      if (!song) {
        await searchingMessage.edit('❌ Şarkı bulunamadı!');
        return;
      }

      queue.addSong(song);
      await searchingMessage.edit(`📝 Kuyruğa eklendi: ${song.title}`);

      if (queue.player.state.status !== AudioPlayerStatus.Playing && !queue.currentSong) {
        await queue.playNext();
      }
    } catch (error) {
      console.error('Play komutu hatası:', error);
      await searchingMessage.edit('❌ Şarkı eklenirken bir hata oluştu.');
    }

    return;
  }

  if (command === '.kuyruk') {
    const lines = [];

    if (queue.currentSong) {
      lines.push(`Şu an: ${queue.currentSong.title}`);
    }

    if (queue.songs.length) {
      lines.push(...queue.songs.map((song, index) => `${index + 1}. ${song.title}`));
    }

    if (!lines.length) {
      return message.reply('📭 Kuyrukta şarkı yok!');
    }

    return message.reply(`📋 Şarkı Kuyruğu:\n${lines.join('\n')}`);
  }

  if (command === '.next') {
    if (!isInSameVoiceChannel(message, queue)) {
      return message.reply('Botu kontrol etmek için botla aynı ses kanalında olmalısınız.');
    }

    const skipped = await queue.skip();
    return message.reply(skipped ? '⏭️ Sıradaki şarkıya geçiliyor...' : '▶️ Şu anda çalan bir şarkı yok!');
  }

  if (command === '.clear') {
    queue.clearSongs();
    return message.reply('🧹 Kuyruk temizlendi!');
  }

  if (command === '.stop') {
    if (!isInSameVoiceChannel(message, queue)) {
      return message.reply('Botu kontrol etmek için botla aynı ses kanalında olmalısınız.');
    }

    queue.stopAll();
    queues.delete(message.guild.id);
    return message.reply('⏹ Müzik durduruldu!');
  }
});

client.login(TOKEN);

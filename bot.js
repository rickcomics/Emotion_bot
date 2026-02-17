const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
require('dotenv').config();
const express = require('express');
const app = express();

// Прослушиваем порт из переменной окружения PORT
const PORT = process.env.PORT || 666;

// Эндпоинт для мониторинга
app.get('/', (req, res) => {
  res.status(200).send('Bot is running');
});

// Можно добавить эндпоинт /health для более явного мониторинга
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Бот запущен (порт ${PORT})`);
});

// самопингование через каждые 4 минуты
setInterval(() => {
  get(`http://localhost:${PORT}`, (res) => {
    console.log("Self-ping:", res.statusCode);
  }).on('error', (err) => {
    console.error("Self-ping failed:", err.message);
  });
}, 240000);




const bot = new TelegramBot(process.env.TOKEN , {
  polling: {
    interval: 300,  // интервал между запросами (мс)
    autoStart: true,
    params: {
      timeout: 10  // таймаут ответа сервера (сек)
    }
  }
});


if (!process.env.TOKEN) {
  console.error('TOKEN не задан в .env');
  process.exit(1);
}


let userData = {};

// Объявляем baseEmotions глобально
let baseEmotions; 

// Загружаем эмоции с обработкой ошибок
try {
  const emotionsData = JSON.parse(fs.readFileSync('./emotion.json', 'utf-8'));
  baseEmotions = emotionsData.baseEmotions;  // Теперь доступна везде
} catch (err) {
  console.error('Ошибка при чтении emotion.json:', err);
  process.exit(1);
}

// Обработчик /start
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (text === '/start') {
    userData[chatId] = {
      step: 'wait_for_situation',
      data: {
        situation: '',
        selectedBaseEmotions: [],
        emotions: [],
        thoughts: '',
        actions: ''
      }
    };
    await bot.sendMessage(chatId, 'Добро пожаловать! Опишите текущую ситуацию:');
  } else if (text) {
    handleUserInput(chatId, text);
  }
});

function handleUserInput(chatId, text) {
  const user = userData[chatId];
  if (!user) return;

  switch (user.step) {
    case 'wait_for_situation':
      handleSituationInput(chatId, text);
      break;
    case 'wait_for_thoughts':
      handleThoughtsInput(chatId, text);
      break;
    case 'wait_for_actions':
      handleActionsInput(chatId, text);
      break;
  }
}

async function handleSituationInput(chatId, text) {
  if (!text) {
    await bot.sendMessage(chatId, 'Пожалуйста, опишите ситуацию.');
    return;
  }
  userData[chatId].data.situation = text;
  userData[chatId].step = 'selecting_base_emotions';
  await sendBaseEmotionChoices(chatId);
}

// Шаг 1: Показываем базовые эмоции
async function sendBaseEmotionChoices(chatId) {
  const { selectedBaseEmotions } = userData[chatId].data;

  // Формируем кнопки как массив массивов (каждая строка — отдельный массив)
  const keyboard = [];
  
  // Добавляем базовые эмоции (по одной на строку или группируем)
  baseEmotions.forEach(emotion => {
    keyboard.push([{
      text: selectedBaseEmotions.includes(emotion.name)
        ? `${emotion.name} ✔️`
        : emotion.name,
      callback_data: `base_${emotion.name}`
    }]);
  });

  // Кнопка "Готово" — отдельная строка
  keyboard.push([
    { text: 'Готово👌', callback_data: 'done_selecting' }
  ]);

  await bot.sendMessage(
    chatId,
    'Выберите базовые чувства (можно несколько):',
    { reply_markup: { inline_keyboard: keyboard } }
  );
}


// Шаг 2: Показываем подэмоции для выбранной базовой
async function sendSubEmotionChoices(chatId, baseEmotionName) {
  const baseEmotion = baseEmotions.find(e => e.name === baseEmotionName);
  if (!baseEmotion) {
    console.error(`Базовая эмоция ${baseEmotionName} не найдена`);
    return;
  }

  const selectedSubs = userData[chatId].data.emotions;
  const ROW_SIZE = 3;

  const subEmotionButtons = baseEmotion.subemotions.map(sub => ({
    text: selectedSubs.includes(sub) ? `✔️ ${sub}` : sub,
    callback_data: `sub_${baseEmotionName}_${sub}`
  }));

  const keyboard = [];
  for (let i = 0; i < subEmotionButtons.length; i += ROW_SIZE) {
    // Каждая строка — массив кнопок
    keyboard.push(subEmotionButtons.slice(i, i + ROW_SIZE));
  }

  // Кнопки "Назад" и "Готово" — отдельная строка
  keyboard.push([
    { text: 'Назад к базовым ↩️', callback_data: 'back_to_base' },
    { text: 'Готово ✅', callback_data: `done_sub_${baseEmotionName}` }
  ]);

  await bot.sendMessage(
    chatId,
    `Выберите подчувства для "${baseEmotionName}":`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

// Важно: answerCallbackQuery вызывается первым делом, чтобы уложиться в 30 с
bot.on('callback_query', async (callbackQuery) => {
  const { message, data, from } = callbackQuery;
  const chatId = message.chat.id;
  const user = userData[chatId];

  // 1. СРАЗУ отвечаем на callback (в пределах 30 с)
  try {
    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (err) {
    console.error('Ошибка ответа на callback:', err);
    return;
  }

  if (!user) {
    return; // Если пользователь не найден, просто выходим
  }

  // 2. Дальше обрабатываем логику
  if (data.startsWith('base_')) {
    const baseName = data.split('_')[1];
    if (!baseName) return;

    if (!user.data.selectedBaseEmotions.includes(baseName)) {
      user.data.selectedBaseEmotions.push(baseName);
    }

    user.step = `selecting_subemotions_${baseName}`;
    await sendSubEmotionChoices(chatId, baseName);
  }

  else if (data.startsWith('sub_')) {
    const parts = data.split('_');
    if (parts.length < 3) return;

    const baseName = parts[1];
    const subName = parts[2];
    const selectedSubs = user.data.emotions;

    if (selectedSubs.includes(subName)) {
      selectedSubs.splice(selectedSubs.indexOf(subName), 1);
    } else {
      if (selectedSubs.length >= 15) {
        await bot.sendMessage(chatId, 'Можно выбрать не более 15 подэмоций.🙈');
        return;
      }
      selectedSubs.push(subName);
    }

    user.data.emotions = selectedSubs;
    await sendSubEmotionChoices(chatId, baseName);
  }

  else if (data === 'back_to_base') {
    user.step = 'selecting_base_emotions';
    await sendBaseEmotionChoices(chatId);
  }

  else if (data.startsWith('done_sub_')) {
    user.step = 'selecting_base_emotions';
    await sendBaseEmotionChoices(chatId);
  }

  else if (data === 'done_selecting') {
    user.step = 'wait_for_thoughts';
    await requestThoughts(chatId);
  }

  else if (data === 'send_to_self') {
    const { situation, selectedBaseEmotions, emotions, thoughts, actions } = user.data;
    const messageText =
      `🟡 Ситуация: ${situation}\n` +
      `🟣 Выбранные базовые чувства: ${selectedBaseEmotions.join(', ')}\n` +
      `🟠 Выбранные подэмоции: ${emotions.join(', ')}\n` +
      `🟢 Мысли: ${thoughts}\n` +
      `🔴 Действия: ${actions}`;

    await bot.sendMessage(chatId, messageText);
    delete userData[chatId];
    await bot.sendMessage(chatId, 'Сводка отправлена!✔️ Чтобы начать заново, отправьте /start.');
  }
});


async function requestThoughts(chatId) {
  await bot.sendMessage(chatId, 'Теперь запишите свои мысли по ситуации:');
}

async function handleThoughtsInput(chatId, text) {
  if (!text) {
    await bot.sendMessage(chatId, 'Пожалуйста, запишите свои мысли.');
    return;
  }
  userData[chatId].data.thoughts = text;
  userData[chatId].step = 'wait_for_actions';
  await requestActions(chatId);
}

async function requestActions(chatId) {
  await bot.sendMessage(chatId, 'Теперь запишите ваши действия:');
}

async function handleActionsInput(chatId, text) {
  if (!text) {
    await bot.sendMessage(chatId, 'Пожалуйста, запишите ваши действия.');
    return;
  }
  userData[chatId].data.actions = text;
  userData[chatId].step = 'ready_to_send';


  await bot.sendMessage(
    chatId,
    'Нажмите «Отправить себе», чтобы получить сводку:',
    {
      reply_markup: {
        inline_keyboard: [[{ text: 'Отправить себе 📩', callback_data: 'send_to_self' }]]
      }
    }
  );
}

// Обработка ошибок для непредвиденных ситуаций
process.on('uncaughtException', (error) => {
  console.error('Неперехваченная ошибка:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Необработанное отклонение промиса:', reason);
});



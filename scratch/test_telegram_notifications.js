const assert = require('assert');
const TelegramNotificationFormatter = require('../src/services/TelegramNotificationFormatter');

console.log('🧪 Iniciando testes de Redesign de Notificações do Telegram...');

// Helper to check valid balanced HTML tags for Telegram
function validateTelegramHtml(html) {
    const bOpen = (html.match(/<b>/g) || []).length;
    const bClose = (html.match(/<\/b>/g) || []).length;
    assert.strictEqual(bOpen, bClose, `Tags <b> desbalanceadas (${bOpen} abertas vs ${bClose} fechadas) em:\n${html}`);

    const iOpen = (html.match(/<i>/g) || []).length;
    const iClose = (html.match(/<\/i>/g) || []).length;
    assert.strictEqual(iOpen, iClose, `Tags <i> desbalanceadas (${iOpen} abertas vs ${iClose} fechadas) em:\n${html}`);

    // Check no unescaped raw '<' or '>' other than allowed tags
    const withoutTags = html.replace(/<\/?(b|i)>/g, '');
    assert(!withoutTags.includes('<'), `Contém caractere '<' não escapado em:\n${html}`);
    assert(!withoutTags.includes('>'), `Contém caractere '>' não escapado em:\n${html}`);
}

// 1. Test Complete Season - Dublado + Legendado
const seasonDual = TelegramNotificationFormatter.formatCompleteSeasonNotification({
    nome: 'Stranger Things',
    ano: '2016',
    nota: 8.6,
    qualidade: '1080p',
    sinopse: 'Quando um garoto desaparece, uma pequena cidade descobre um mistério envolvendo experimentos secretos.'
}, {
    seasonNum: 2,
    totalEps: 9,
    isDublado: true,
    isLegendado: true
});

console.log('\n--- Notificação Temporada Completa (Dual) ---');
console.log(seasonDual);

validateTelegramHtml(seasonDual);
assert(seasonDual.includes('🎉 <b>TEMPORADA COMPLETA!</b>'));
assert(seasonDual.includes('📺 <b>Stranger Things — 2ª Temporada</b> · 2016'));
assert(seasonDual.includes('🎬 <b>9 episódios</b> · 🇧🇷 Dublado + Legendado'));
assert(seasonDual.includes('⭐ <b>8,6/10</b> · 1080p Full HD'));
assert(seasonDual.includes('🍿 <b>Todos os episódios já disponíveis para maratonar!</b>'));
console.log('✅ Teste 1 (Temporada Completa Dual) passou com sucesso');

// 2. Test Complete Season - Dublado Only & Legendado Only
const seasonDub = TelegramNotificationFormatter.formatCompleteSeasonNotification({
    nome: 'Reacher',
    ano: '2022',
    nota: 8.1
}, {
    seasonNum: 1,
    totalEps: 8,
    isDublado: true,
    isLegendado: false
});
validateTelegramHtml(seasonDub);
assert(seasonDub.includes('🇧🇷 Dublado'));
assert(!seasonDub.includes('Legendado'));
console.log('✅ Teste 2 (Temporada Dublada) passou com sucesso');

const seasonLeg = TelegramNotificationFormatter.formatCompleteSeasonNotification({
    nome: 'Shogun',
    ano: '2024',
    nota: 8.8
}, {
    seasonNum: 1,
    totalEps: 10,
    isDublado: false,
    isLegendado: true
});
validateTelegramHtml(seasonLeg);
assert(seasonLeg.includes('💬 Legendado PT-BR'));
console.log('✅ Teste 3 (Temporada Legendada) passou com sucesso');

// 3. Test Movie - Dublado + Legendado
const movieDual = TelegramNotificationFormatter.formatMovieNotification({
    nome: 'Oppenheimer',
    ano: '2023',
    nota: 8.6,
    qualidade: '1080p',
    isDublado: true,
    isLegendado: true,
    sinopse: 'A história do físico americano J. Robert Oppenheimer, seu papel no Projeto Manhattan e o desenvolvimento da bomba atômica.'
});

console.log('\n--- Notificação Filme (Dual) ---');
console.log(movieDual);

validateTelegramHtml(movieDual);
assert(movieDual.includes('🎬 <b>FILME DISPONÍVEL!</b>'));
assert(movieDual.includes('🍿 <b>Oppenheimer</b> · 2023'));
assert(movieDual.includes('⭐ <b>8,6/10</b> · 1080p Full HD'));
assert(movieDual.includes('<b>🇧🇷 Dublado + Legendado</b>'));
assert(movieDual.includes('▶️ <b>Já disponível para assistir!</b>'));
console.log('✅ Teste 4 (Filme Dual) passou com sucesso');

// 4. Test Movie - CAM / Versão Cinema
const movieCam = TelegramNotificationFormatter.formatMovieNotification({
    nome: 'Deadpool & Wolverine',
    ano: '2024',
    nota: 7.9,
    isCam: true,
    isDublado: true,
    isLegendado: false
});
validateTelegramHtml(movieCam);
assert(movieCam.includes('Versão Cinema (CAM)'));
assert(movieCam.includes('<b>🇧🇷 Dublado</b>'));
console.log('✅ Teste 5 (Filme CAM) passou com sucesso');

// 5. Test Special Characters and XSS/Markdown breaking strings
const specialCharsItem = {
    nome: 'Homem-Aranha: <Através> do Aranhaverso & [Especial] *100%* _Top_',
    ano: '2023',
    nota: 8.9,
    sinopse: 'Miles Morales é catapultado através do Multiverso onde encontra uma equipe de "Pessoas-Aranha" <encarregadas> de proteger sua existência.'
};
const movieSpecial = TelegramNotificationFormatter.formatMovieNotification(specialCharsItem);
validateTelegramHtml(movieSpecial);
assert(movieSpecial.includes('&lt;Através&gt;'));
assert(movieSpecial.includes('&amp;'));
assert(movieSpecial.includes('&quot;Pessoas-Aranha&quot;'));
console.log('✅ Teste 6 (Caracteres Especiais & Escape Seguro) passou com sucesso');

// 6. Test Missing Optional Metadata (sem ano, sem nota, sem sinopse)
const minimalMovie = TelegramNotificationFormatter.formatMovieNotification({
    nome: 'Filme Raro Clássico',
    isDublado: true
});
validateTelegramHtml(minimalMovie);
assert(minimalMovie.includes('🍿 <b>Filme Raro Clássico</b>'));
assert(minimalMovie.includes('📺 <b>até 1080p</b>'));
assert(!minimalMovie.includes('undefined'));
assert(!minimalMovie.includes('null'));
console.log('✅ Teste 7 (Metadados Opcionais Ausentes) passou com sucesso');

// 7. Test Long Synopsis truncation
const longSynopsis = 'Era uma vez uma história extremamente longa que continuava por centenas de linhas e descrevia com riqueza de detalhes todos os acontecimentos inimagináveis de uma jornada épica pelo cosmos infinito onde cada estrela guardava um segredo milenar que nenhum ser humano jamais ousou desvendar até que chegou o momento fatídico em que o destino de todos os mundos colapsou em uma única decisão.';
const movieLong = TelegramNotificationFormatter.formatMovieNotification({
    nome: 'Filme Épico',
    sinopse: longSynopsis,
    isDublado: true
});
validateTelegramHtml(movieLong);
assert(movieLong.includes('...'));
console.log('✅ Teste 8 (Truncamento de Sinopse Longa) passou com sucesso');

// 8. Test Inline Keyboards
const kbFilme = TelegramNotificationFormatter.buildInlineKeyboard('filme', 123);
assert.strictEqual(kbFilme.inline_keyboard[0][0].text, '🌐 Assistir no Site');
assert.strictEqual(kbFilme.inline_keyboard[0][0].url, 'https://brasilflix.kapsu.com.br/#filme/123');
assert.strictEqual(kbFilme.inline_keyboard[0][1].text, '📱 Assistir pelo Bot');
assert.strictEqual(kbFilme.inline_keyboard[0][1].url, 'https://t.me/BrasilFlix_bot?start=ver_123');

const kbSerie = TelegramNotificationFormatter.buildInlineKeyboard('serie', 456, 3);
assert.strictEqual(kbSerie.inline_keyboard[0][0].url, 'https://brasilflix.kapsu.com.br/#serie/456/temporada/3/episodio/1');
console.log('✅ Teste 9 (Botões Inline no Site e Bot) passou com sucesso');

console.log('\n🎉 TODOS OS TESTES DE REDESIGN DE NOTIFICAÇÕES PASSARAM COM 100% DE SUCESSO!');

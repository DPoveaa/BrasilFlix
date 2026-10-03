'use strict';

/**
 * Normaliza um título para comparação:
 *  - Lowercase
 *  - Remove anos (2018), (2023) etc.
 *  - Remove acentos
 *  - Remove tudo que não for letra/dígito
 */
function normalizeTitle(title) {
    if (!title) return '';
    return String(title)
        .toLowerCase()
        .replace(/\s*\(\d{4}\)|\b\d{4}\b/g, '') // remove anos como (2018), 2023
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
        .replace(/[^a-z0-9]/g, '') // remove pontuacao e espacos
        .trim();
}

/**
 * Palavras-chave que indicam que o subtítulo (parte após ':' ou '–' ou ' - ') representa
 * um arco, saga, filme, spin-off ou nova série DISTINTA.
 *
 * ATENÇÃO: A lógica de isSameMedia NÃO usa mais esta lista para decidir.
 * Ela existe apenas como referência/documentação de casos conhecidos.
 * A decisão de alias válido é feita via KNOWN_SUBTITLE_ALIASES (lista branca).
 */
const DISTINCT_SUBTITLE_KEYWORDS = [
    // Arcos de Bleach
    'thousandyear', 'bloodwar', 'tybw', 'sennenkessen', 'sennen',
    // Sufixos Dragon Ball
    'super', 'gt', 'kai',
    // Sufixos Naruto
    'shippuden', 'boruto',
    // Sufixos One Piece
    'strong', 'world', 'stampede', 'gold',
    // Pokémon versões novas
    'horizons', 'horizontes', 'theseries', 'thejourneys', 'journeys', 'adventures',
    'sunandmoon', 'xy', 'blackandwhite', 'diamond', 'pearl', 'ruby', 'sapphire',
    'indigo', 'johto', 'hoenn', 'sinnoh', 'unova', 'kalos', 'alola', 'galar', 'paldea',
    // SAO
    'alicization', 'progressive', 'fairy', 'extra',
    // Attack on Titan
    'thefinal', 'theroar', 'junior',
    // Sufixos genéricos de série distinta
    'final',
    'film', 'filme', 'movie', 'cinema', 'theatrical',
    'ova', 'ona', 'oav', 'special', 'especial',
    'part', 'parte',
    'arc', 'saga',
    'zero', 'origins', 'origin', 'beginning', 'genesis',
    'revolution', 'rebellion', 'war', 'wars',
    'afterstory', 'after',
    'brotherhood',
    'next', 'future',
    'mugen', 'ressha', 'train',
    'brave', 'souls',
];

/**
 * LISTA BRANCA de aliases de subtítulo: pares (prefixo, subtítulo) onde o subtítulo
 * é apenas um apelido alternativo da MESMA série — não uma série distinta.
 *
 * Formato: { 'prefixonormalizado': ['subtiulo1normalizado', 'subtitulo2normalizado'] }
 *
 * Ex: "Demon Slayer: Kimetsu no Yaiba" → o subtítulo "kimetsunoyaiba" é alias de "demonslayer".
 *
 * REGRA: só adicione aqui se o subtítulo nomeia EXATAMENTE a mesma série, sem
 * nenhum arco, temporada ou spin-off adicional. Quando em dúvida, NÃO adicione.
 */
const KNOWN_SUBTITLE_ALIASES = {
    'demonslayer': ['kimetsunoyaiba'],
    'attackontitan': ['shingekinokyojin'],
    'myheroacademia': ['bokunoheroacademia', 'bnha'],
    'jujutsukaisen': ['sorceryfight'],
    'hunterxhunter': ['hunterhunter', 'hxh'],
    'fullmetalalchemist': ['haganenorenkinjutsushi', 'fma'],
    'konosuba': ['konosubarashiisekaanishukufukuwo'],
    'danmachi': ['isitwrongtotrytopickupgirlsinadungeon'],
    'thattimeigotreincarnatedasaslime': ['tenseishitaraslimedattaken', 'slimetensei', 'tensura'],
    'spyxfamily': ['spyfamily'],
    'tokyoghoul': ['tokyogula'],
    'neongenesisevangelion': ['evangelion', 'eva', 'nge'],
    'yurionice': ['yurionais'],
};

/**
 * Franquias conhecidas onde o título ocidental e o título original japonês (romaji)
 * são comumente alternados SEM separador ':' — portanto são o mesmo conteúdo.
 */
const KNOWN_FRANCHISE_ALIASES = [
    ['demonslayer', 'kimetsunoyaiba'],
    ['attackontitan', 'shingekinokyojin'],
    ['myheroacademia', 'bokunoheroacademia', 'bnha'],
    ['jujutsukaisen', 'sorceryfight'],
    ['hunterxhunter', 'hunterhunter', 'hxh'],
    ['fullmetalalchemist', 'haganenorenkinjutsushi', 'fma'],
    ['konosuba', 'konosubarashiisekaanishukufukuwo'],
    ['danmachi', 'isitwrongtotrytopickupgirlsinadungeon'],
    ['thattimeigotreincarnatedasaslime', 'tenseishitaraslimedattaken', 'slimetensei', 'tensura'],
    ['spyxfamily', 'spyfamily'],
    ['sololeveling', 'oredakedanivelupnaken', 'nahonjamanlevelup'],
    ['frieren', 'sousounofrieren', 'frierenbeyondjourneysend'],
    ['dungeonmeshi', 'deliciousindungeon'],
    ['chainsawman', 'csm'],
    ['jojosbizarreadventure', 'jojonokimyounabouken', 'jojo'],
    ['onepiece', 'wanpisu'],
    ['bleach', 'burichi'],
    ['drstone', 'doctorstone'],
    ['fireforce', 'ennennoshouboutai'],
    ['hellsparadise', 'jigokuraku'],
    ['mashle', 'mashlemagicandmuscles'],
    ['kaijuno8', 'kaiju8', 'kaijuunihou']
];

function extractPrefixAndSubtitle(raw) {
    if (!raw) return null;
    // Regex preserva 'Re:' ou prefixos curtos (ex: Re:ZERO) evitando corte indesejado
    const match = raw.match(/^((?:Re:)?\w[^\s:\u2013\-]*.*?)(?:\s*[:\u2013]\s*|\s+-\s+)(.+)$/i);
    if (!match) return null;
    const prefNorm = normalizeTitle(match[1]);
    if (prefNorm.length <= 2) return null;
    return {
        prefix: prefNorm,
        subtitle: normalizeTitle(match[2])
    };
}

/**
 * Verifica se dois títulos de mídia se referem ao mesmo conteúdo.
 *
 * ─── FILOSOFIA DE SEGURANÇA (evita mistura de séries) ───────────────────────
 * 1. Títulos normalizados idênticos → mesmo conteúdo.
 * 2. Aliases diretos conhecidos sem separador (ex: "Demon Slayer" vs "Kimetsu no Yaiba") → mesmo.
 * 3. "Franquia: SubTítulo" vs "Franquia" → DISTINTO por padrão.
 *    EXCEÇÃO: se o subtítulo estiver em KNOWN_SUBTITLE_ALIASES para o prefixo, é alias válido.
 *
 * Isso garante que "Pokémon" ≠ "Pokémon: Horizontes", "Bleach" ≠ "Bleach: Sennen Kessen-hen",
 * "Dragon Ball" ≠ "Dragon Ball Super", "SAO" ≠ "SAO: Alicization", etc.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * @param {string} titleA
 * @param {string} titleB
 * @returns {boolean}
 */
function isSameMedia(titleA, titleB) {
    if (!titleA || !titleB) return false;

    const nA = normalizeTitle(titleA);
    const nB = normalizeTitle(titleB);

    // Caso trivial: títulos normalizados idênticos
    if (nA === nB) return true;

    // Checagem de aliases diretos sem separador (ex: "Demon Slayer" vs "Kimetsu no Yaiba")
    for (const group of KNOWN_FRANCHISE_ALIASES) {
        if (group.includes(nA) && group.includes(nB)) {
            return true;
        }
    }

    const splitA = extractPrefixAndSubtitle(titleA);
    const splitB = extractPrefixAndSubtitle(titleB);

    const prefA = splitA ? splitA.prefix : null;
    const prefB = splitB ? splitB.prefix : null;

    // Função auxiliar para checar se dois prefixos são equivalentes (direto ou por alias)
    const prefixesMatch = (p1, p2) => {
        if (!p1 || !p2) return false;
        if (p1 === p2) return true;
        for (const group of KNOWN_FRANCHISE_ALIASES) {
            if (group.includes(p1) && group.includes(p2)) return true;
        }
        return false;
    };

    // Caso: "Franquia" (nA sem separador) vs "Franquia: SubTítulo" (splitB com separador)
    const aIsPrefixOfB = prefB !== null && (nA === prefB || prefixesMatch(nA, prefB));
    // Caso: "Franquia: SubTítulo" (splitA com separador) vs "Franquia" (nB sem separador)
    const bIsPrefixOfA = prefA !== null && (nB === prefA || prefixesMatch(nB, prefA));

    if (aIsPrefixOfB) {
        // PROTEÇÃO: só é alias se o subtítulo de B estiver na lista branca
        const knownAliases = KNOWN_SUBTITLE_ALIASES[prefB] || [];
        return knownAliases.includes(splitB.subtitle);
    }

    if (bIsPrefixOfA) {
        // PROTEÇÃO: só é alias se o subtítulo de A estiver na lista branca
        const knownAliases = KNOWN_SUBTITLE_ALIASES[prefA] || [];
        return knownAliases.includes(splitA.subtitle);
    }

    return false;
}

/**
 * Grupos de palavras-chave distintas de franquia para isolar versões, sequências e spin-offs.
 * Garante que uma versão/sequência nunca seja aceita para outra (ex: Pokémon Horizons vs Pokémon 1997,
 * Bleach TYBW vs Bleach 2004, Dragon Ball Super vs DBZ, etc.).
 */
const DISTINCT_FRANCHISE_GROUPS = [
    {
        name: 'Bleach: Thousand-Year Blood War',
        keys: ['thousandyear', 'bloodwar', 'tybw', 'sennenkessen', 'sennen', 'kessen', 'rebirthofsouls']
    },
    {
        name: 'Dragon Ball Super',
        keys: ['dbsuper', 'super']
    },
    {
        name: 'Dragon Ball GT',
        keys: ['dbgt', 'gt']
    },
    {
        name: 'Dragon Ball Kai',
        keys: ['dbkai', 'kai']
    },
    {
        name: 'Dragon Ball Daima',
        keys: ['daima']
    },
    {
        name: 'Naruto Shippuden',
        keys: ['shippuden', 'shippuuden']
    },
    {
        name: 'Boruto',
        keys: ['boruto']
    },
    {
        name: 'Pokémon Horizons',
        keys: ['horizons', 'horizontes']
    },
    {
        name: 'Pokémon Chronicles',
        keys: ['chronicles', 'cronicas']
    },
    {
        name: 'Pokémon Origins',
        keys: ['origins', 'origens']
    },
    {
        name: 'Pokémon Generations',
        keys: ['generations', 'geracoes']
    },
    {
        name: 'Pokémon Concierge',
        keys: ['concierge']
    },
    {
        name: 'One Piece Live Action',
        keys: ['liveaction', 'aserie']
    },
    {
        name: 'Fullmetal Alchemist: Brotherhood',
        keys: ['brotherhood']
    },
    {
        name: 'Sword Art Online: Alicization',
        keys: ['alicization']
    },
    {
        name: 'Sword Art Online: Progressive',
        keys: ['progressive']
    }
];

/**
 * Valida rigorosamente se o título de uma release (torrent, stream ou arquivo) é compatível
 * com o conteúdo alvo que estamos buscando, bloqueando a mistura de spin-offs, versões ou sequências distintas.
 *
 * @param {string} releaseTitle - Título bruto do torrent/release/arquivo (ex: "Pokemon Horizons (Season 1)...")
 * @param {string} targetTitle - Título da série alvo (ex: "Pokémon" ou "Bleach")
 * @param {string|null} originalName - Nome original da série alvo (ex: "Pocket Monsters" ou "BLEACH")
 * @param {object} options - Opções adicionais ({ ano, isAnime, tipo, isLiveActionExplicit })
 * @returns {boolean} true se compatível, false se pertencer a série/spin-off diferente
 */
function isReleaseCompatibleWithTarget(releaseTitle, targetTitle, originalName = null, options = {}) {
    if (!releaseTitle || !targetTitle) return true;
    const normRel = releaseTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normTarget = (targetTitle || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const normOrig = (originalName || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    // 1. Grupos de franquia distinta (Pokémon Horizons vs 1997, Bleach TYBW vs 2004, etc.)
    for (const group of DISTINCT_FRANCHISE_GROUPS) {
        const inRelease = group.keys.some(k => normRel.includes(k));
        const inTarget = group.keys.some(k => normTarget.includes(k) || normOrig.includes(k));

        // Se o release tem a marca distintiva mas o target NÃO tem -> REJEITA (ex: release é Horizons mas target é Pokémon)
        if (inRelease && !inTarget) {
            return false;
        }

        // Se o target tem a marca distintiva mas o release NÃO tem -> REJEITA (ex: target é Horizons mas release é Pokémon 1997)
        if (inTarget && !inRelease) {
            return false;
        }
    }

    // 2. Validação Live-Action vs Anime
    const isLiveActionExplicit = /\b(live[-_ .]?action)\b/i.test(releaseTitle);
    const targetIsLiveAction = /\b(live[-_ .]?action|a série|a serie)\b/i.test(targetTitle) || !!options.isLiveActionExplicit;
    if (isLiveActionExplicit && !targetIsLiveAction) return false;
    if (!isLiveActionExplicit && targetIsLiveAction && /\b(anime)\b/i.test(releaseTitle)) return false;

    // 3. Validação de Ano distante se especificado (impede confusão de remakes/reboots muito distantes)
    if (options.ano) {
        const expectedYear = parseInt(options.ano, 10);
        if (!isNaN(expectedYear) && expectedYear > 1900) {
            const titleYearMatch = releaseTitle.match(/\b(19\d{2}|20\d{2})\b/);
            if (titleYearMatch) {
                const releaseYear = parseInt(titleYearMatch[1], 10);
                // Permite variação máxima de 1 ano
                if (Math.abs(releaseYear - expectedYear) > 1) {
                    return false;
                }
            }
        }
    }

    return true;
}

module.exports = { 
    normalizeTitle, 
    isSameMedia, 
    isReleaseCompatibleWithTarget,
    DISTINCT_SUBTITLE_KEYWORDS, 
    DISTINCT_FRANCHISE_GROUPS,
    KNOWN_FRANCHISE_ALIASES, 
    KNOWN_SUBTITLE_ALIASES 
};
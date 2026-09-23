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
 * um arco, saga, filme ou spin-off DISTINTO — portanto NÃO é um simples alias.
 */
const DISTINCT_SUBTITLE_KEYWORDS = [
    'thousandyear', 'bloodwar', 'tybw',
    'final',
    'film', 'filme', 'movie', 'cinema', 'theatrical',
    'ova', 'ona', 'oav', 'special', 'especial',
    'part', 'parte',
    'arc', 'saga',
    'zero', 'origins', 'origin', 'beginning', 'genesis',
    'revolution', 'rebellion', 'war', 'wars',
    'shippuden', 'boruto',
    'afterstory', 'after',
    'brotherhood',
    'next', 'future',
    'mugen', 'ressha', 'train'
];

/**
 * Franquias conhecidas onde o título ocidental e o título original japonês (romaji)
 * são comumente alternados sem separador.
 */
const KNOWN_FRANCHISE_ALIASES = [
    ['demonslayer', 'kimetsunoyaiba'],
    ['attackontitan', 'shingekinokyojin'],
    ['myheroacademia', 'bokunoheroacademia'],
    ['jujutsukaisen', 'sorceryfight'],
    ['hunterxhunter', 'hunterhunter'],
    ['fullmetalalchemist', 'haganenorenkinjutsushi'],
    ['konosuba', 'konosubarashiisekaanishukufukuwo'],
    ['danmachi', 'isitwrongtotrytopickupgirlsinadungeon'],
    ['thattimeigotreincarnatedasaslime', 'tenseishitaraslimedattaken', 'slimetensei'],
    ['spyxfamily', 'spyfamily']
];

function extractPrefixAndSubtitle(raw) {
    if (!raw) return null;
    // Regex preserva 'Re:' ou prefixos curtos (ex: Re:ZERO) evitando corte indesejado
    const match = raw.match(/^((?:Re:)?\w[^\s:–\-]*.*?)(?:\s*[:–]\s*|\s+-\s+)(.+)$/i);
    if (!match) return null;
    const prefNorm = normalizeTitle(match[1]);
    if (prefNorm.length <= 2) return null;
    return {
        prefix: prefNorm,
        subtitle: normalizeTitle(match[2])
    };
}

/**
 * Verifica se dois títulos de mídia se referem ao mesmo conteúdo,
 * tratando casos de alias (nome curto vs nome completo com subtítulo alternativo).
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

    // Checagem de aliases conhecidos diretos (sem subtítulo, ex: "Demon Slayer" vs "Kimetsu no Yaiba")
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

    // Caso 1: Um deles é o prefixo do outro
    // Ex: "Demon Slayer" (nA) vs "Demon Slayer: Kimetsu no Yaiba" (splitB.prefix)
    const aIsPrefixOfB = prefB !== null && (nA === prefB || prefixesMatch(nA, prefB));
    const bIsPrefixOfA = prefA !== null && (nB === prefA || prefixesMatch(nB, prefA));

    if (aIsPrefixOfB || bIsPrefixOfA) {
        const relevantSub = aIsPrefixOfB ? splitB.subtitle : splitA.subtitle;
        const isDistinct = DISTINCT_SUBTITLE_KEYWORDS.some(k => relevantSub.includes(k));
        if (!isDistinct) return true;
    }

    return false;
}

module.exports = { normalizeTitle, isSameMedia, DISTINCT_SUBTITLE_KEYWORDS, KNOWN_FRANCHISE_ALIASES };
/**
 * TelegramNotificationFormatter.js
 * Formatação padronizada, moderna e limpa de notificações públicas de lançamentos para o Telegram.
 */

class TelegramNotificationFormatter {
    /**
     * Escapa caracteres especiais para modo HTML do Telegram
     */
    static escapeHtml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * Formata nota numérica (ex: 8.6 -> "8,6")
     */
    static formatRating(nota) {
        if (!nota || isNaN(nota) || Number(nota) <= 0) return null;
        const val = Number(nota).toFixed(1);
        return val.replace('.', ',');
    }

    /**
     * Formata texto de qualidade
     */
    static formatQuality(qualidade, isCam = false) {
        if (isCam) return 'Versão Cinema (CAM)';
        if (!qualidade) return 'até 1080p';
        
        const qUpper = qualidade.toUpperCase();
        if (qUpper.includes('CAM')) return 'Versão Cinema (CAM)';
        if (qUpper.includes('4K') || qUpper.includes('2160P')) return '4K Ultra HD';
        if (qUpper.includes('1080P') || qUpper.includes('FULL HD') || qUpper.includes('FHD')) return '1080p Full HD';
        if (qUpper.includes('720P') || qUpper.includes('HD')) return '720p HD';
        
        return qualidade;
    }

    /**
     * Formata texto de áudio / legendas de forma dinâmica
     */
    static formatAudioText(isDublado, isLegendado, audioRaw = '') {
        const hasDub = isDublado || (audioRaw && audioRaw.toLowerCase().includes('dublado'));
        const hasLeg = isLegendado || (audioRaw && audioRaw.toLowerCase().includes('legendado'));

        if (hasDub && hasLeg) {
            return '🇧🇷 Dublado + Legendado';
        } else if (hasDub) {
            return '🇧🇷 Dublado';
        } else if (hasLeg) {
            return '💬 Legendado PT-BR';
        }
        return '🇧🇷 Dublado';
    }

    /**
     * Trunca e formata a sinopse com segurança
     */
    static formatSynopsis(sinopse, maxLen = 220) {
        if (!sinopse) return '';
        let clean = String(sinopse).trim().replace(/\s+/g, ' ');
        if (clean.length > maxLen) {
            const cut = clean.substring(0, maxLen);
            const lastSpace = cut.lastIndexOf(' ');
            clean = (lastSpace > 0 ? cut.substring(0, lastSpace) : cut) + '...';
        }
        return this.escapeHtml(clean);
    }

    /**
     * Gera a notificação para Filme Disponível
     */
    static formatMovieNotification(filme) {
        const titleSafe = this.escapeHtml(filme.nome || 'Filme');
        const yearPart = filme.ano ? ` · ${this.escapeHtml(filme.ano)}` : '';
        
        const rating = this.formatRating(filme.nota);
        const qual = this.formatQuality(filme.qualidade, filme.isCam);
        const audioText = this.formatAudioText(filme.isDublado, filme.isLegendado, filme.audio);
        const synopsis = this.formatSynopsis(filme.sinopse || filme.descricao);

        let header = '🎬 <b>FILME DISPONÍVEL!</b>';
        if (filme.isAnime) header = '⛩️ <b>FILME DISPONÍVEL!</b>';

        let ratingAndQualLine = '';
        if (rating) {
            ratingAndQualLine = `⭐ <b>${rating}/10</b> · ${qual}`;
        } else {
            ratingAndQualLine = `📺 <b>${qual}</b>`;
        }

        const lines = [
            header,
            '',
            `🍿 <b>${titleSafe}</b>${yearPart}`,
            ratingAndQualLine,
            `<b>${audioText}</b>`
        ];

        if (synopsis) {
            lines.push('');
            lines.push(`<i>${synopsis}</i>`);
        }

        lines.push('');
        lines.push('▶️ <b>Já disponível para assistir!</b>');

        return lines.join('\n');
    }

    /**
     * Gera a notificação para Temporada Completa de Série / Dorama / Anime
     */
    static formatCompleteSeasonNotification(serie, detalhes = {}) {
        const seasonNum = detalhes.seasonNum || 1;
        const totalEps = detalhes.totalEps || (serie.totalEpisodios || 1);
        const titleSafe = this.escapeHtml(serie.nome || 'Série');
        const yearPart = serie.ano ? ` · ${this.escapeHtml(serie.ano)}` : '';

        const isDub = detalhes.audio === 'dublado' || (detalhes.isDublado ?? serie.isDublado);
        const isLeg = detalhes.audio === 'legendado' || (detalhes.isLegendado ?? serie.isLegendado);
        const audioText = this.formatAudioText(isDub, isLeg, detalhes.audio || serie.audio);

        const rating = this.formatRating(serie.nota);
        const qual = this.formatQuality(detalhes.qualidade || serie.qualidade || '1080p');
        const synopsis = this.formatSynopsis(serie.sinopse || serie.descricao);

        let header = '🎉 <b>TEMPORADA COMPLETA!</b>';
        if (serie.isAnime) {
            header = '⛩️ <b>TEMPORADA COMPLETA!</b>';
        } else if (serie.isMicrodrama || serie.subtipo === 'microdrama') {
            header = '📱 <b>MICRODRAMA COMPLETO!</b>';
        } else if (serie.isDorama) {
            header = '🌸 <b>TEMPORADA COMPLETA!</b>';
        }

        const seasonLabel = `${seasonNum}ª Temporada`;

        let ratingAndQualLine = '';
        if (rating) {
            ratingAndQualLine = `⭐ <b>${rating}/10</b> · ${qual}`;
        } else {
            ratingAndQualLine = `📺 <b>${qual}</b>`;
        }

        const epCountText = `${totalEps} ${totalEps === 1 ? 'episódio' : 'episódios'}`;

        const lines = [
            header,
            '',
            `📺 <b>${titleSafe} — ${seasonLabel}</b>${yearPart}`,
            `🎬 <b>${epCountText}</b> · ${audioText}`,
            ratingAndQualLine
        ];

        if (synopsis) {
            lines.push('');
            lines.push(`<i>${synopsis}</i>`);
        }

        lines.push('');
        lines.push('🍿 <b>Todos os episódios já disponíveis para maratonar!</b>');

        return lines.join('\n');
    }

    /**
     * Constrói os botões inline de ação padronizados
     */
    static buildInlineKeyboard(tipo, id, seasonNum = 1) {
        let siteUrl = `https://brasilflix.kapsu.com.br/#filme/${id}`;
        let botUrl = `https://t.me/BrasilFlix_bot?start=ver_${id}`;

        if (tipo === 'serie') {
            siteUrl = `https://brasilflix.kapsu.com.br/#serie/${id}/temporada/${seasonNum}/episodio/1`;
            botUrl = `https://t.me/BrasilFlix_bot?start=ver_${id}`;
        }

        return {
            inline_keyboard: [
                [
                    { text: '🌐 Assistir no Site', url: siteUrl },
                    { text: '📱 Assistir pelo Bot', url: botUrl }
                ]
            ]
        };
    }
}

module.exports = TelegramNotificationFormatter;

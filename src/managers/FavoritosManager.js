const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');
const db = require('../database/db');

class FavoritosManager {
    constructor() {
        this.favoritos = {}; // cache: userId -> Array de itens favoritados
        this.userVisits = {};
        this.loadData();
    }

    async loadData() {
        try {
            const res = await db.query(`SELECT * FROM favoritos ORDER BY created_at DESC`);
            this.favoritos = {};
            for (const f of res.rows) {
                const uId = f.user_id.toString();
                if (!this.favoritos[uId]) this.favoritos[uId] = [];
                this.favoritos[uId].push({
                    id: f.item_id,
                    tipo: f.tipo,
                    dataFavoritado: f.created_at
                });
            }
        } catch (e) {
            console.warn('⚠️ Erro ao carregar favoritos do PostgreSQL:', e.message);
        }
    }

    registrarVisitaECalcularNovidades(userId, totalCatalogoAtual) {
        const strId = userId.toString();
        const agora = new Date().toISOString();
        const ultimaVisita = this.userVisits[strId];

        let novidades = 0;
        if (ultimaVisita && ultimaVisita.totalAoVisitar !== undefined) {
            novidades = Math.max(0, totalCatalogoAtual - ultimaVisita.totalAoVisitar);
        }

        this.userVisits[strId] = {
            ultimaVisita: agora,
            totalAoVisitar: totalCatalogoAtual
        };

        return novidades;
    }

    isFavorito(userId, itemId, tipo = 'filme') {
        const strId = userId.toString();
        const userFavs = this.favoritos[strId] || [];
        return userFavs.some(f => f.id === itemId && f.tipo === tipo);
    }

    async toggleFavorito(userId, item) {
        const strId = userId.toString();
        if (!this.favoritos[strId]) {
            this.favoritos[strId] = [];
        }

        const index = this.favoritos[strId].findIndex(f => f.id === item.id && f.tipo === item.tipo);
        if (index >= 0) {
            this.favoritos[strId].splice(index, 1);
            try {
                await db.query(`DELETE FROM favoritos WHERE user_id = $1 AND item_id = $2 AND tipo = $3`, [
                    userId, item.id, item.tipo
                ]);
            } catch (e) {
                console.warn('⚠️ Erro ao remover favorito no PostgreSQL:', e.message);
            }
            return { action: 'removido', item };
        } else {
            this.favoritos[strId].push({
                id: item.id,
                tipo: item.tipo,
                nome: item.nome,
                ano: item.ano || '',
                posterUrl: item.posterUrl || '',
                dataFavoritado: new Date().toISOString()
            });

            try {
                await db.query(`
                    INSERT INTO favoritos (user_id, item_id, tipo, created_at)
                    VALUES ($1, $2, $3, NOW())
                    ON CONFLICT (user_id, item_id, tipo) DO NOTHING
                `, [userId, item.id, item.tipo]);
            } catch (e) {
                console.warn('⚠️ Erro ao salvar favorito no PostgreSQL:', e.message);
            }

            return { action: 'adicionado', item };
        }
    }

    getFavoritos(userId) {
        const strId = userId.toString();
        return this.favoritos[strId] || [];
    }

    getUsuariosQueFavoritaram(itemId, tipo = 'serie') {
        const userIds = [];
        for (const [userId, favs] of Object.entries(this.favoritos)) {
            if (favs.some(f => f.id === itemId && f.tipo === tipo)) {
                userIds.push(userId);
            }
        }
        return userIds;
    }
}

module.exports = FavoritosManager;

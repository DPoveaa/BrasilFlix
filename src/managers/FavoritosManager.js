const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');

class FavoritosManager {
    constructor() {
        this.favoritosFile = path.join(config.DATA_DIR, 'favoritos.json');
        this.userVisitsFile = path.join(config.DATA_DIR, 'user_visits.json');
        this.favoritos = {};
        this.userVisits = {};
        this.loadData();
    }

    loadData() {
        try {
            fs.ensureDirSync(config.DATA_DIR);
            if (fs.existsSync(this.favoritosFile)) {
                this.favoritos = fs.readJsonSync(this.favoritosFile);
            } else {
                this.favoritos = {};
                this.saveFavoritos();
            }

            if (fs.existsSync(this.userVisitsFile)) {
                this.userVisits = fs.readJsonSync(this.userVisitsFile);
            } else {
                this.userVisits = {};
                this.saveVisits();
            }
        } catch (error) {
            console.error('❌ Erro ao carregar favoritos:', error);
            this.favoritos = {};
            this.userVisits = {};
        }
    }

    saveFavoritos() {
        try {
            fs.writeJsonSync(this.favoritosFile, this.favoritos, { spaces: 2 });
        } catch (error) {
            console.error('❌ Erro ao salvar favoritos:', error);
        }
    }

    saveVisits() {
        try {
            fs.writeJsonSync(this.userVisitsFile, this.userVisits, { spaces: 2 });
        } catch (error) {
            console.error('❌ Erro ao salvar visitas:', error);
        }
    }

    // Registra a visita do usuário e calcula quantos títulos novos foram adicionados desde a última visita
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
        this.saveVisits();

        return novidades;
    }

    isFavorito(userId, itemId, tipo = 'filme') {
        const strId = userId.toString();
        const userFavs = this.favoritos[strId] || [];
        return userFavs.some(f => f.id === itemId && f.tipo === tipo);
    }

    toggleFavorito(userId, item) {
        const strId = userId.toString();
        if (!this.favoritos[strId]) {
            this.favoritos[strId] = [];
        }

        const index = this.favoritos[strId].findIndex(f => f.id === item.id && f.tipo === item.tipo);
        if (index >= 0) {
            this.favoritos[strId].splice(index, 1);
            this.saveFavoritos();
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
            this.saveFavoritos();
            return { action: 'adicionado', item };
        }
    }

    getFavoritos(userId) {
        const strId = userId.toString();
        return this.favoritos[strId] || [];
    }

    // Retorna a lista de usuários que favoritaram determinada série para notificar quando sair novo episódio
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

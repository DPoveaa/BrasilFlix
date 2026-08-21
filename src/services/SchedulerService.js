const fs = require('fs-extra');
const path = require('path');
const EventEmitter = require('events');

// Fuso horário de Brasília (BRT = UTC-3)
const BRT_OFFSET_HOURS = -3;

class SchedulerService extends EventEmitter {
    constructor() {
        super();
        this.dataPath = path.join(__dirname, '../../data/scheduler.json');

        // Grade padrão: Seg-Sex (1-5), 01h-05h no horário de Brasília
        this.defaultConfig = {
            ativo: true,             // Se o scheduler está habilitado. false = roda 24h
            diasSemana: [1, 2, 3, 4, 5], // 0=Dom, 1=Seg, ..., 6=Sab
            horaInicio: 1,           // hora de início (0-23, BRT)
            horaFim: 5               // hora de fim (0-23, BRT) — exclusivo (para às 05:00:00)
        };

        // Overrides por data: chave = "YYYY-MM-DD", valor = { horaInicio, horaFim } ou false (desabilitar)
        this.overrides = {};

        // Controle manual: null = seguir grade, 'start' = forçar ligado, 'stop' = forçar parado
        this.forceState = null;
        this.forceReason = null;

        this._config = { ...this.defaultConfig };
        this._schedulerTickInterval = null;
        this._lastAllowed = null; // para detectar mudanças de estado e logar

        this._load();
        this._startTick();
    }

    // ─── Persistência ────────────────────────────────────────────────────────

    _load() {
        try {
            if (fs.existsSync(this.dataPath)) {
                const saved = fs.readJsonSync(this.dataPath);
                if (saved.config) this._config = { ...this.defaultConfig, ...saved.config };
                if (saved.overrides) this.overrides = saved.overrides || {};
                if (saved.forceState !== undefined) this.forceState = saved.forceState || null;
                if (saved.forceReason !== undefined) this.forceReason = saved.forceReason || null;
                console.log(`⏱️  [Scheduler] Configuração carregada: ${JSON.stringify(this._config)} | Overrides: ${Object.keys(this.overrides).length} | ForceState: ${this.forceState || 'nenhum'}`);
            } else {
                this._save();
                console.log('⏱️  [Scheduler] Arquivo de configuração criado com padrão Seg-Sex 01h-05h (BRT).');
            }
        } catch (e) {
            console.warn('⚠️  [Scheduler] Erro ao carregar configuração:', e.message);
        }
    }

    _save() {
        try {
            fs.ensureDirSync(path.dirname(this.dataPath));
            fs.writeJsonSync(this.dataPath, {
                config: this._config,
                overrides: this.overrides,
                forceState: this.forceState,
                forceReason: this.forceReason,
                updatedAt: new Date().toISOString()
            }, { spaces: 2 });
        } catch (e) {
            console.warn('⚠️  [Scheduler] Erro ao salvar configuração:', e.message);
        }
    }

    // ─── Utilitários de Tempo (BRT) ──────────────────────────────────────────

    _nowBRT() {
        const now = new Date();
        // Ajusta para BRT (UTC-3)
        return new Date(now.getTime() + (BRT_OFFSET_HOURS * 60 * 60 * 1000));
    }

    _todayKey() {
        const brt = this._nowBRT();
        return brt.toISOString().slice(0, 10); // "YYYY-MM-DD"
    }

    // ─── Lógica Principal ─────────────────────────────────────────────────────

    /**
     * Retorna true se o processamento está autorizado neste momento.
     */
    isAllowedToRun() {
        // Scheduler desabilitado globalmente = sempre roda
        if (!this._config.ativo) return true;

        // Force stop manual tem prioridade máxima
        if (this.forceState === 'stop') return false;

        // Force start manual permite rodar independente da grade
        if (this.forceState === 'start') return true;

        const brt = this._nowBRT();
        const diaSemana = brt.getUTCDay(); // 0=Dom, 1=Seg, ..., 6=Sab
        const hora = brt.getUTCHours();
        const hoje = this._todayKey();

        // Verifica override da data de hoje
        if (this.overrides.hasOwnProperty(hoje)) {
            const ov = this.overrides[hoje];
            if (ov === false) return false; // Dia bloqueado por override
            if (typeof ov === 'object' && ov !== null) {
                const { horaInicio, horaFim } = ov;
                return hora >= horaInicio && hora < horaFim;
            }
        }

        // Aplica a grade padrão
        if (!this._config.diasSemana.includes(diaSemana)) return false;
        return hora >= this._config.horaInicio && hora < this._config.horaFim;
    }

    /**
     * Retorna detalhes do estado atual para a API.
     */
    getStatus() {
        const brt = this._nowBRT();
        const hoje = this._todayKey();
        const allowed = this.isAllowedToRun();
        const diaSemana = brt.getUTCDay();
        const hora = brt.getUTCHours();

        let motivo = '';
        if (!this._config.ativo) {
            motivo = 'Scheduler desabilitado — rodando 24h';
        } else if (this.forceState === 'stop') {
            motivo = `⏹ Parado manualmente: ${this.forceReason || 'via painel admin'}`;
        } else if (this.forceState === 'start') {
            motivo = `▶️ Iniciado manualmente: ${this.forceReason || 'via painel admin'}`;
        } else if (this.overrides.hasOwnProperty(hoje)) {
            const ov = this.overrides[hoje];
            if (ov === false) motivo = `Override: dia ${hoje} bloqueado`;
            else motivo = `Override: hoje das ${ov.horaInicio}h às ${ov.horaFim}h`;
        } else {
            const diasNomes = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
            const diasAtivos = this._config.diasSemana.map(d => diasNomes[d]).join(', ');
            motivo = `Grade padrão: ${diasAtivos} das ${this._config.horaInicio}h às ${this._config.horaFim}h (BRT)`;
        }

        // Próxima janela de execução
        const proximaJanela = this._calcProximaJanela();

        return {
            allowed,
            forceState: this.forceState,
            forceReason: this.forceReason,
            motivo,
            agora: brt.toISOString(),
            horaAtualBRT: hora,
            diaAtualBRT: diaSemana,
            config: this._config,
            overrides: this.overrides,
            proximaJanela
        };
    }

    _calcProximaJanela() {
        if (!this._config.ativo) return null;
        if (this.forceState === 'start') return { tipo: 'ativa agora (forçado)' };

        const brt = this._nowBRT();
        const diasNomes = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

        // Verifica os próximos 8 dias
        for (let delta = 0; delta <= 8; delta++) {
            const candidato = new Date(brt.getTime() + delta * 24 * 60 * 60 * 1000);
            const dataCandidato = candidato.toISOString().slice(0, 10);
            const diaCandidato = candidato.getUTCDay();
            const horaCandidato = delta === 0 ? candidato.getUTCHours() : 0;

            let hIni, hFim;
            if (this.overrides.hasOwnProperty(dataCandidato)) {
                const ov = this.overrides[dataCandidato];
                if (ov === false) continue;
                if (typeof ov === 'object') { hIni = ov.horaInicio; hFim = ov.horaFim; }
            } else {
                if (!this._config.diasSemana.includes(diaCandidato)) continue;
                hIni = this._config.horaInicio;
                hFim = this._config.horaFim;
            }

            if (delta === 0 && horaCandidato >= hFim) continue;

            const startHora = delta === 0 ? Math.max(horaCandidato, hIni) : hIni;
            return {
                data: dataCandidato,
                dia: diasNomes[diaCandidato],
                horaInicio: hIni,
                horaFim: hFim,
                descricao: `${diasNomes[diaCandidato]} (${dataCandidato}) das ${hIni}h às ${hFim}h`
            };
        }

        return null;
    }

    // ─── Controles Manuais ────────────────────────────────────────────────────

    forceStart(reason = 'Manual via painel admin') {
        this.forceState = 'start';
        this.forceReason = reason;
        this._save();
        console.log(`▶️  [Scheduler] Force Start ativado: ${reason}`);
        this.emit('stateChange', { allowed: true, reason });
    }

    forceStop(reason = 'Manual via painel admin') {
        this.forceState = 'stop';
        this.forceReason = reason;
        this._save();
        console.log(`⏹  [Scheduler] Force Stop ativado: ${reason}`);
        this.emit('stateChange', { allowed: false, reason });
    }

    clearForce() {
        this.forceState = null;
        this.forceReason = null;
        this._save();
        console.log('🔄 [Scheduler] Controle manual removido — voltando à grade padrão.');
        this.emit('stateChange', { allowed: this.isAllowedToRun(), reason: 'Grade padrão restaurada' });
    }

    // ─── Configuração da Grade ────────────────────────────────────────────────

    updateConfig(newConfig) {
        const diasValidos = (newConfig.diasSemana || []).map(Number).filter(d => d >= 0 && d <= 6);
        const horaInicio = parseInt(newConfig.horaInicio ?? this._config.horaInicio, 10);
        const horaFim = parseInt(newConfig.horaFim ?? this._config.horaFim, 10);

        if (horaInicio < 0 || horaInicio > 23 || horaFim < 0 || horaFim > 23) {
            throw new Error('Horas devem estar entre 0 e 23.');
        }

        this._config = {
            ativo: newConfig.ativo !== undefined ? Boolean(newConfig.ativo) : this._config.ativo,
            diasSemana: diasValidos.length > 0 ? diasValidos : this._config.diasSemana,
            horaInicio,
            horaFim
        };
        this._save();
        console.log(`⚙️  [Scheduler] Configuração atualizada: ${JSON.stringify(this._config)}`);
        this.emit('configChange', this._config);
    }

    // ─── Overrides de Data ────────────────────────────────────────────────────

    setOverride(data, config) {
        // data = "YYYY-MM-DD", config = { horaInicio, horaFim } ou false
        if (config === false || config === null) {
            this.overrides[data] = false;
        } else {
            const horaInicio = parseInt(config.horaInicio, 10);
            const horaFim = parseInt(config.horaFim, 10);
            if (isNaN(horaInicio) || isNaN(horaFim) || horaInicio < 0 || horaInicio > 23 || horaFim < 0 || horaFim > 23) {
                throw new Error('Horas do override devem estar entre 0 e 23.');
            }
            this.overrides[data] = { horaInicio, horaFim };
        }
        this._save();
        console.log(`📅 [Scheduler] Override configurado para ${data}:`, this.overrides[data]);
    }

    removeOverride(data) {
        if (this.overrides.hasOwnProperty(data)) {
            delete this.overrides[data];
            this._save();
            console.log(`🗑️  [Scheduler] Override removido para ${data}`);
        }
    }

    // ─── Tick Automático ──────────────────────────────────────────────────────

    _startTick() {
        // Verifica a cada 60s se o estado mudou (para logar e emitir evento)
        this._schedulerTickInterval = setInterval(() => {
            const allowed = this.isAllowedToRun();
            if (this._lastAllowed !== null && this._lastAllowed !== allowed) {
                const msg = allowed
                    ? '▶️  [Scheduler] Janela de processamento aberta! Retomando downloads...'
                    : '⏹  [Scheduler] Janela de processamento encerrada. Aguardando próxima janela...';
                console.log(msg);
                this.emit('stateChange', { allowed, reason: 'Mudança automática de horário' });
            }
            this._lastAllowed = allowed;
        }, 60 * 1000);

        // Garante que o intervalo não impeça o processo de encerrar
        if (this._schedulerTickInterval.unref) this._schedulerTickInterval.unref();
    }

    stop() {
        if (this._schedulerTickInterval) {
            clearInterval(this._schedulerTickInterval);
            this._schedulerTickInterval = null;
        }
    }
}

module.exports = new SchedulerService();

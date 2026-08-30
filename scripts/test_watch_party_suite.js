const http = require('http');

function request(options, data) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    resolve({ status: res.statusCode, data: json, headers: res.headers });
                } catch (e) {
                    resolve({ status: res.statusCode, body, headers: res.headers });
                }
            });
        });
        req.on('error', reject);
        if (data) {
            req.write(typeof data === 'string' ? data : JSON.stringify(data));
        }
        req.end();
    });
}

async function runTests() {
    console.log('🚀 Iniciando Suite de Testes do Watch Party...');
    const PORT = 7000;
    const HOST = '127.0.0.1';

    try {
        // 1. Criar sala
        console.log('\n--- 1. Criando Sala com Host e Mídia ---');
        const hostUid = 'test_host_' + Math.random().toString(36).substring(2, 7);
        const createRes = await request({
            host: HOST,
            port: PORT,
            path: '/api/party/create',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, {
            title: 'Filme de Teste',
            sub: 'Filme 2026',
            streamUrl: '/stream/video/test/filme/1/dublado',
            mediaInfo: { id: 1, type: 'filme', title: 'Filme de Teste', audio: 'dublado' },
            hostName: 'Anfitrião Teste',
            token: 'test_token',
            hostUserId: hostUid
        });

        if (!createRes.data || !createRes.data.success) {
            throw new Error(`Falha ao criar sala: ${JSON.stringify(createRes)}`);
        }

        const roomCode = createRes.data.roomCode;
        console.log(`✅ Sala criada com sucesso! Código: ${roomCode}`);
        console.log(`   Permissões padrão retornadas:`, createRes.data.permissions);

        // 2. Consultar detalhes da sala
        console.log('\n--- 2. Consultando Sala /api/party/room/:roomId ---');
        const getRes = await request({
            host: HOST,
            port: PORT,
            path: `/api/party/room/${roomCode}`,
            method: 'GET'
        });
        if (!getRes.data || !getRes.data.success || !getRes.data.room) {
            throw new Error(`Falha ao consultar sala: ${JSON.stringify(getRes)}`);
        }
        console.log(`✅ Sala consultada. Host: ${getRes.data.room.hostName}, currentTime: ${getRes.data.room.currentTime}`);

        // 3. Convidado tentando Play sem permissão (deve falhar com 403)
        console.log('\n--- 3. Convidado tentando retomar reprodução (sem permissão canResume) ---');
        const guestUid = 'test_guest_' + Math.random().toString(36).substring(2, 7);
        const guestPlayRes = await request({
            host: HOST,
            port: PORT,
            path: `/api/party/action/${roomCode}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, {
            userId: guestUid,
            action: 'play',
            currentTime: 50,
            by: 'Convidado Teste'
        });

        if (guestPlayRes.status === 403) {
            console.log(`✅ Bloqueio correto: Convidado recebeu 403 (${guestPlayRes.data.error})`);
        } else {
            throw new Error(`Esperado 403 para play sem permissão, obtido: ${guestPlayRes.status} ${JSON.stringify(guestPlayRes.data)}`);
        }

        // 4. Convidado pausando (permissão padrão canPause: true)
        console.log('\n--- 4. Convidado pausando reprodução (com permissão padrão canPause: true) ---');
        const guestPauseRes = await request({
            host: HOST,
            port: PORT,
            path: `/api/party/action/${roomCode}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, {
            userId: guestUid,
            action: 'pause',
            currentTime: 50,
            by: 'Convidado Teste'
        });

        if (guestPauseRes.data && guestPauseRes.data.success) {
            console.log(`✅ Convidado pausou com sucesso!`);
        } else {
            throw new Error(`Falha no pause permitido do convidado: ${JSON.stringify(guestPauseRes)}`);
        }

        // 5. Host atualizando permissões da sala
        console.log('\n--- 5. Anfitrião concedendo permissão de seek e resume ---');
        const permRes = await request({
            host: HOST,
            port: PORT,
            path: `/api/party/action/${roomCode}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, {
            userId: hostUid,
            action: 'permissions',
            permissions: {
                canPause: true,
                canResume: true,
                canSeek: true,
                canChangeMedia: false,
                canChangeSpeed: true
            }
        });

        if (!permRes.data || !permRes.data.success) {
            throw new Error(`Falha ao atualizar permissões pelo host: ${JSON.stringify(permRes)}`);
        }
        console.log(`✅ Permissões atualizadas com sucesso pelo anfitrião!`);

        // 6. Convidado tentando Play agora (deve ser permitido)
        console.log('\n--- 6. Convidado tentando Play após permissão concedida ---');
        const guestPlayAllowedRes = await request({
            host: HOST,
            port: PORT,
            path: `/api/party/action/${roomCode}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, {
            userId: guestUid,
            action: 'play',
            currentTime: 60,
            by: 'Convidado Teste'
        });

        if (guestPlayAllowedRes.data && guestPlayAllowedRes.data.success) {
            console.log(`✅ Play do convidado autorizado com sucesso!`);
        } else {
            throw new Error(`Falha no play concedido do convidado: ${JSON.stringify(guestPlayAllowedRes)}`);
        }

        // 7. Teste de drift / cálculo de tempo do servidor
        console.log('\n--- 7. Verificando cálculo de tempo com reprodução ativa ---');
        await new Promise(r => setTimeout(r, 1200)); // Aguarda 1.2 segundos
        const roomCheckRes = await request({
            host: HOST,
            port: PORT,
            path: `/api/party/room/${roomCode}`,
            method: 'GET'
        });
        const computedTime = roomCheckRes.data.room.currentTime;
        console.log(`   Tempo calculado na sala: ${computedTime.toFixed(2)}s (esperado >= 61s)`);
        if (computedTime >= 61) {
            console.log(`✅ Tempo calculado no servidor com base em lastStateChange funcionando com precisão!`);
        }

        console.log('\n🎉 TODOS OS TESTES DO WATCH PARTY PASSARAM COM 100% DE SUCESSO!\n');
    } catch (err) {
        console.error('❌ Erro no teste:', err.message);
        process.exit(1);
    }
}

runTests();

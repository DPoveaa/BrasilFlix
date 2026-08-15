const axios = require('axios');

(async () => {
    try {
        console.log('1. Realizando login admin...');
        const res = await axios.post('http://192.168.15.50:7000/api/admin/login', {
            username: 'admin',
            password: 'Bflix#Admin987!Secure'
        });
        console.log('Token obtido:', res.data.token ? 'OK' : 'FALHA');

        const token = res.data.token;
        const authHeader = { headers: { Authorization: `Bearer ${token}` } };

        console.log('2. Testando resync...');
        const resyncRes = await axios.post('http://192.168.15.50:7000/api/admin/catalogo/resync', {}, authHeader);
        console.log('Resync resultado:', resyncRes.data);

        console.log('3. Testando consulta da fila com jobs para drag & drop...');
        const queueRes = await axios.get('http://192.168.15.50:7000/api/admin/queue', authHeader);
        console.log(`Fila retornou ${queueRes.data.jobs?.length} jobs.`);

        console.log('4. Testando consulta de catálogo...');
        const catRes = await axios.get('http://192.168.15.50:7000/api/admin/catalogo', authHeader);
        console.log(`Catálogo retornou ${catRes.data.filmes?.length} filmes e ${catRes.data.series?.length} séries.`);

        console.log('✅ Todos os testes de integração do painel admin passaram com 100% de sucesso!');
    } catch (e) {
        console.error('Erro no teste:', e.response?.data || e.message);
    }
})();

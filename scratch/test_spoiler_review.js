async function test() {
    try {
        console.log('1. Postando avaliação com spoiler...');
        const res = await fetch('https://brasilflix.kapsu.com.br/api/media/serie/17/comentarios', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                rating: 9,
                comentario: 'CUIDADO: O devorador de mentes ataca no final da temporada!',
                guestName: 'Teste Spoiler',
                hasSpoiler: true
            })
        });
        const text = await res.text();
        console.log('Status POST:', res.status, 'Body:', text);

        console.log('2. Buscando avaliações para verificar has_spoiler...');
        const getRes = await fetch('https://brasilflix.kapsu.com.br/api/media/serie/17/comentarios');
        const getData = await getRes.json();
        console.log('Últimos comentários:', getData.reviews?.slice(0, 3));
    } catch (e) {
        console.error('Erro no teste:', e);
    }
}

test();

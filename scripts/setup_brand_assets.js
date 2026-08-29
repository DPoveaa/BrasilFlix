const fs = require('fs-extra');
const path = require('path');

async function main() {
    const brainDir = 'C:/Users/danie/.gemini/antigravity-ide/brain/17bc0b27-8329-4dcc-b160-1091bad696ee';
    const userUploaded = path.join(brainDir, '.user_uploaded', 'media_1787933008416.jpg');

    const symbolIcon = path.join(brainDir, 'brasilflix_symbol_icon_1787933106434.jpg');
    const horizontalLogo = path.join(brainDir, 'brasilflix_horizontal_logo_1787933123226.jpg');
    const botAvatar = path.join(brainDir, 'brasilflix_bot_avatar_1787933144175.jpg');
    const vipAvatar = path.join(brainDir, 'brasilflix_vip_clients_avatar_1787933167879.jpg');
    const storageAvatar = path.join(brainDir, 'brasilflix_storage_group_avatar_1787933194826.jpg');

    const publicLogos = path.join(__dirname, '../public/assets/logos');
    const publicTelegram = path.join(__dirname, '../public/assets/telegram');
    const publicDir = path.join(__dirname, '../public');

    await fs.ensureDir(publicLogos);
    await fs.ensureDir(publicTelegram);

    // Copiar arquivos para os destinos locais
    if (fs.existsSync(userUploaded)) {
        await fs.copy(userUploaded, path.join(publicLogos, 'original_logo.jpg'));
    }
    if (fs.existsSync(symbolIcon)) {
        await fs.copy(symbolIcon, path.join(publicLogos, 'symbol_icon.jpg'));
        await fs.copy(symbolIcon, path.join(publicDir, 'favicon.png'));
        await fs.copy(symbolIcon, path.join(publicDir, 'icon.png'));
    }
    if (fs.existsSync(horizontalLogo)) {
        await fs.copy(horizontalLogo, path.join(publicLogos, 'logo_horizontal.jpg'));
        await fs.copy(horizontalLogo, path.join(publicDir, 'logo.jpg'));
    }
    if (fs.existsSync(botAvatar)) {
        await fs.copy(botAvatar, path.join(publicTelegram, 'bot_avatar.jpg'));
    }
    if (fs.existsSync(vipAvatar)) {
        await fs.copy(vipAvatar, path.join(publicTelegram, 'vip_clients_avatar.jpg'));
    }
    if (fs.existsSync(storageAvatar)) {
        await fs.copy(storageAvatar, path.join(publicTelegram, 'storage_group_avatar.jpg'));
    }

    console.log('✅ Todos os assets de marca foram copiados para /public/assets com sucesso!');
}

main().catch(console.error);

const express = require('express');
const { GoogleGenAI } = require("@google/genai");
const { google } = require("googleapis");
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// Função de Loop de Tentativas (Retry Logic)
async function chamarGeminiComRetry(ai, prompt, tentativas = 5) {
    for (let i = 0; i < tentativas; i++) {
        try {
            // Usamos o gemini-1.5-flash que é mais leve e estável
            return await ai.models.generateContent({
                model: 'gemini-1.5-flash',
                contents: prompt
            });
        } catch (erro) {
            console.warn(`⚠️ Tentativa ${i + 1} falhou: ${erro.message}`);
            if (i === tentativas - 1) throw erro;
            // Espera curta (1s, 2s, 3s...) para não sobrecarregar
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
}

app.post('/api/gemini-workspace', async (req, res) => {
    try {
        const { pergunta } = req.body;
        const credenciaisGoogle = process.env.GOOGLE_CREDENTIALS;
        const pastaId = process.env.GOOGLE_DRIVE_FOLDER_ID;
        const chaveGemini = process.env.GEMINI_API_KEY;

        // Autenticação Drive
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(credenciaisGoogle),
            scopes: ['https://www.googleapis.com/auth/drive.readonly']
        });
        const drive = google.drive({ version: 'v3', auth });

        const listaDrive = await drive.files.list({
            q: `'${pastaId}' in parents and mimeType='application/pdf' and trashed = false`,
            fields: 'files(id, name, webViewLink)'
        });

        const ficheiros = listaDrive.data.files;
        const ai = new GoogleGenAI({ apiKey: chaveGemini });

        const promptSistema = `Você é um arquivista. Identifique o PDF correto para a pergunta: "${pergunta}".
        Arquivos: ${JSON.stringify(ficheiros.map(f => ({ id: f.id, nome: f.name })))}
        Responda com [ID:seu_id_aqui].`;

        // Chamada usando o sistema de loop
        const response = await chamarGeminiComRetry(ai, promptSistema);
        
        const textoResposta = response.text || "";
        const matchId = textoResposta.match(/\[ID:(.*?)\]/);
        
        let pdfUrl = null;
        if (matchId) {
            const arquivo = ficheiros.find(f => f.id === matchId[1].trim());
            if (arquivo) pdfUrl = arquivo.webViewLink.replace('/view', '/preview');
        }

        return res.json({
            resultado: textoResposta.replace(/\[ID:.*?\]/g, '').trim(),
            pdfUrl: pdfUrl
        });

    } catch (erroGeral) {
        console.error("❌ Erro após 5 tentativas:", erroGeral.message);
        return res.status(503).json({ resultado: "O sistema está sobrecarregado. Por favor, tente novamente." });
    }
});

app.listen(PORT, () => console.log(`🚀 Servidor rodando com 5 tentativas automáticas.`));

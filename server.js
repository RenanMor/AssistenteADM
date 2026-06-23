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
            // O modelo 'gemini-1.5-flash' é o mais estável e rápido para este propósito
            return await ai.models.generateContent({
                model: 'gemini-1.5-flash',
                contents: prompt
            });
        } catch (erro) {
            console.warn(`⚠️ Tentativa ${i + 1} falhou: ${erro.message}`);
            // Se for erro de rede ou sobrecarga, aguarda e tenta novamente
            if (i < tentativas - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
            } else {
                throw erro; // Lança o erro após esgotar as 5 tentativas
            }
        }
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/gemini-workspace', async (req, res) => {
    try {
        const { pergunta } = req.body;
        if (!pergunta) return res.status(400).json({ resultado: "Pergunta ausente." });

        const credenciaisGoogle = process.env.GOOGLE_CREDENTIALS;
        const pastaId = process.env.GOOGLE_DRIVE_FOLDER_ID;
        const chaveGemini = process.env.GEMINI_API_KEY;

        if (!credenciaisGoogle || !pastaId || !chaveGemini) {
            return res.status(500).json({ resultado: "Erro: Variáveis de ambiente faltando no Render." });
        }

        // 1. Autenticação Drive
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(credenciaisGoogle),
            scopes: ['https://www.googleapis.com/auth/drive.readonly']
        });
        const drive = google.drive({ version: 'v3', auth });

        // 2. Listar arquivos
        const listaDrive = await drive.files.list({
            q: `'${pastaId}' in parents and mimeType='application/pdf' and trashed = false`,
            fields: 'files(id, name, webViewLink)'
        });

        const ficheiros = listaDrive.data.files;
        if (!ficheiros || ficheiros.length === 0) {
            return res.json({ resultado: "Nenhum PDF encontrado na pasta." });
        }

        // 3. IA para triagem
        const ai = new GoogleGenAI({ apiKey: chaveGemini });
        const promptSistema = `Você é um organizador de seguros. Analise a pergunta: "${pergunta}".
        Identifique o arquivo correto entre os disponíveis, considerando variações de nomes e sobrenomes de casada/solteira.
        Arquivos: ${JSON.stringify(ficheiros.map(f => ({ id: f.id, nome: f.name })))}
        
        Responda confirmando a ação e termine com [ID:seu_id_aqui].`;

        const response = await chamarGeminiComRetry(ai, promptSistema);
        
        const textoResposta = response.text || "";
        const matchId = textoResposta.match(/\[ID:(.*?)\]/);
        
        let pdfUrl = null;
        if (matchId) {
            const idEncontrado = matchId[1].trim();
            const arquivo = ficheiros.find(f => f.id === idEncontrado);
            if (arquivo && arquivo.webViewLink) {
                pdfUrl = arquivo.webViewLink.replace('/view', '/preview');
            }
        }

        return res.json({
            resultado: textoResposta.replace(/\[ID:.*?\]/g, '').trim(),
            pdfUrl: pdfUrl
        });

    } catch (erroGeral) {
        console.error("❌ Erro final:", erroGeral.message);
        return res.status(503).json({ resultado: "O sistema está sobrecarregado no momento. Tente novamente em alguns segundos." });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando com sucesso na porta ${PORT}`);
});

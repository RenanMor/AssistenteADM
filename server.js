const express = require('express');
const { GoogleGenAI } = require("@google/genai");
const { google } = require("googleapis");
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

// Serve todos os arquivos estáticos diretamente da raiz do projeto
app.use(express.static(__dirname));

// Rota explícita para garantir que o index.html seja aberto ao acessar o site
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/gemini-workspace', async (req, res) => {
    try {
        const { pergunta } = req.body;

        if (!pergunta) {
            return res.status(400).json({ resultado: "A pergunta não foi fornecida." });
        }

        // 1. Tratamento da Chave Privada do Google
        let chaveFormatada = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
        if (chaveFormatada) {
            chaveFormatada = chaveFormatada.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
        }

        // 2. Autenticação no Google Drive via Conta de Serviço
        const auth = new google.auth.JWT(
            process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            null,
            chaveFormatada,
            ['https://www.googleapis.com/auth/drive.readonly']
        );

        const drive = google.drive({ version: 'v3', auth });
        const pastaId = process.env.GOOGLE_DRIVE_FOLDER_ID;

        const listaDrive = await drive.files.list({
            q: `'${pastaId}' in parents and mimeType='application/pdf' and trashed = false`,
            fields: 'files(id, name, webViewLink)'
        });

        const ficheiros = listaDrive.data.files;
        if (!ficheiros || ficheiros.length === 0) {
            return res.json({ resultado: "Nenhum arquivo PDF foi encontrado na pasta do Drive configurada. Verifique as permissões do robô." });
        }

        // 3. Inicialização e chamada da API do Gemini
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

        const promptSistema = `Você é um assistente inteligente integrado ao Google Drive de uma corretora de seguros. 
        Analise a pergunta do usuário e a lista de arquivos PDFs disponíveis abaixo para encontrar a resposta correta.
        
        Arquivos disponíveis na pasta do Drive: ${JSON.stringify(ficheiros.map(f => ({ nome: f.name, id: f.id })))}
        
        Responda à dúvida do usuário de forma clara e profissional. 
        OBRIGATORIAMENTE, no final da sua resposta, inclua o ID do arquivo correto no formato [ID:identificador_do_arquivo] e a página estimada no formato [PAGINA:numero_da_pagina].
        Exemplo de final de resposta: "... O valor total é R$ 1.500. [ID:1A2B3C4D] [PAGINA:3]"
        
        Pergunta do usuário: ${pergunta}`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: promptSistema
        });

        const textoResposta = response.text;
        const matchId = textoResposta.match(/\[ID:(.*?)\]/);
        const matchPagina = textoResposta.match(/\[PAGINA:(\d+)\]/);

        let idEncontrado = null;
        let paginaEncontrada = 1;
        let pdfUrl = null;

        if (matchId) idEncontrado = matchId[1].trim();
        if (matchPagina) paginaEncontrada = parseInt(matchPagina[1]);

        if (idEncontrado) {
            const fCorrespondente = ficheiros.find(f => f.id === idEncontrado);
            if (fCorrespondente && fCorrespondente.webViewLink) {
                // Modifica o link padrão para o modo preview (obrigatório para rodar dentro de iframes)
                pdfUrl = fCorrespondente.webViewLink.replace('/view', '/preview');
            }
        }

        const respostaLimpa = textoResposta.replace(/\[ID:.*?\]|\[PAGINA:\d+\]/g, '').trim();

        return res.json({
            resultado: respostaLimpa,
            pdfUrl: pdfUrl,
            pagina: paginaEncontrada
        });

    } catch (erro) {
        console.error("ERRO NO SERVIDOR:", erro);
        return res.status(500).json({ resultado: `Erro interno no servidor: ${erro.message}` });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor rodando com sucesso na porta ${PORT}`);
});

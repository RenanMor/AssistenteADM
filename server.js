const express = require('express');
const { GoogleGenAI } = require("@google/genai");
const { google } = require("googleapis");
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração para processar JSON
app.use(express.json({ limit: '50mb' }));

// Serve todos os arquivos estáticos diretamente da raiz do projeto
app.use(express.static(__dirname));

// Rota principal que abre o chat automaticamente
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Rota que processa a pesquisa no Drive e envia para o Gemini
app.post('/api/gemini-workspace', async (req, res) => {
    try {
        const { pergunta } = req.body;

        if (!pergunta) {
            return res.status(400).json({ resultado: "A pergunta não foi fornecida pelo usuário." });
        }

        // 1. Captura e validação rigorosa das Variáveis de Ambiente do Render
        const emailRobo = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
        let chavePrivada = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
        const pastaId = process.env.GOOGLE_DRIVE_FOLDER_ID;
        const chaveGemini = process.env.GEMINI_API_KEY;

        // Se alguma variável estiver faltando no Render, avisa diretamente no console e na tela do chat
        if (!emailRobo || !chavePrivada || !pastaId || !chaveGemini) {
            console.error("❌ ERRO CRÍTICO: Variáveis de ambiente ausentes no painel do Render.");
            return res.status(500).json({ 
                resultado: `Erro de Configuração: Verifique o painel do Render. Status das chaves -> E-mail: ${!!emailRobo}, Chave Privada: ${!!chavePrivada}, ID Pasta: ${!!pastaId}, Chave Gemini: ${!!chaveGemini}` 
            });
        }

        // 2. Limpeza da Chave Privada (Remove aspas acidentais e corrige quebras de linha)
        chavePrivada = chavePrivada.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');

        // 3. Autenticação oficial no Google Drive via JWT (Conta de Serviço)
        const auth = new google.auth.JWT(
            emailRobo,
            null,
            chavePrivada,
            ['https://www.googleapis.com/auth/drive.readonly']
        );

        const drive = google.drive({ version: 'v3', auth });

        // 4. Listagem segura de arquivos da pasta do Google Drive
        let listaDrive;
        try {
            listaDrive = await drive.files.list({
                q: `'${pastaId}' in parents and mimeType='application/pdf' and trashed = false`,
                fields: 'files(id, name, webViewLink)'
            });
        } catch (erroDrive) {
            console.error("❌ ERRO NO GOOGLE DRIVE API:", erroDrive.message);
            return res.status(500).json({ 
                resultado: `O Google Drive recusou o acesso. Detalhes: ${erroDrive.message}. Certifique-se de que removeu as aspas ao colar a chave privada no Render e que compartilhou a pasta com o e-mail do robô.` 
            });
        }

        const ficheiros = listaDrive.data.files;
        if (!ficheiros || ficheiros.length === 0) {
            return res.json({ resultado: "Nenhum arquivo PDF foi localizado dentro da pasta configurada no Google Drive." });
        }

        // 5. Inicialização da inteligência do Gemini AI
        const ai = new GoogleGenAI({ apiKey: chaveGemini });

        const promptSistema = `Você é um assistente inteligente integrado ao Google Drive de uma corretora de seguros. 
        Analise a pergunta do usuário e a lista de arquivos PDFs disponíveis abaixo para encontrar a resposta correta.
        
        Arquivos disponíveis na pasta do Drive: ${JSON.stringify(ficheiros.map(f => ({ nome: f.name, id: f.id })))}
        
        Responda à dúvida do usuário de forma clara e profissional. 
        OBRIGATORIAMENTE, no final da sua resposta, inclua o ID do arquivo correto no formato [ID:identificador_do_arquivo] e a página estimada no formato [PAGINA:numero_da_pagina].
        Exemplo de final de resposta: "... O valor total é R$ 1.500. [ID:1A2B3C4D] [PAGINA:3]"
        
        Pergunta do usuário: ${pergunta}`;

        let response;
        try {
            response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: promptSistema
            });
        } catch (erroGemini) {
            console.error("❌ ERRO NA API DO GEMINI:", erroGemini.message);
            return res.status(500).json({ resultado: `Falha na API do Gemini: ${erroGemini.message}` });
        }

        const textoResposta = response.text;

        // 6. Extração de Metadados ([ID:...] e [PAGINA:...]) para carregar o PDF lateralmente
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
                // Altera o link padrão de visualização para o modo de embutir em iframe (/preview)
                pdfUrl = fCorrespondente.webViewLink.replace('/view', '/preview');
            }
        }

        // Limpa as tags técnicas da resposta para que o usuário final veja apenas o texto puro
        const respostaLimpa = textoResposta.replace(/\[ID:.*?\]|\[PAGINA:\d+\]/g, '').trim();

        // Retorna a resposta limpa e os metadados do PDF para o index.html
        return res.json({
            resultado: respostaLimpa,
            pdfUrl: pdfUrl,
            pagina: paginaEncontrada
        });

    } catch (erroGeral) {
        console.error("❌ ERRO GERAL NO SERVIDOR:", erroGeral);
        return res.status(500).json({ resultado: `Erro inesperado interno no servidor: ${erroGeral.message}` });
    }
});

// Inicialização oficial do Servidor Express
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando com sucesso no Render na porta ${PORT}`);
});

const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));

// Armazenar conexões ativas
const activeConnections = new Map();

console.log('🚀 Iniciando MongoDB TLS Proxy Service...');

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'MongoDB TLS Proxy',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      status: '/status',
      health: '/health',
      connect: 'POST /connect',
      query: 'POST /query',
      collections: 'GET /collections/:connectionId',
      disconnect: 'DELETE /disconnect/:connectionId'
    },
    timestamp: new Date().toISOString()
  });
});

// Função para criar conexão MongoDB com TLS
async function createMongoConnection(config) {
  const { mongoUrl, database, tlsConfig } = config;
  
  console.log('🔗 Criando conexão MongoDB TLS...');
  console.log('Database:', database);
  console.log('TLS Config:', tlsConfig ? { enabled: tlsConfig.enabled, insecure: tlsConfig.insecure } : 'disabled');
  
  const options = {
    connectTimeoutMS: 30000,
    serverSelectionTimeoutMS: 30000,
  };

  if (tlsConfig?.enabled) {
    options.tls = true;
    options.tlsAllowInvalidCertificates = tlsConfig.insecure || false;
    options.tlsAllowInvalidHostnames = tlsConfig.insecure || false;
    
    if (tlsConfig.caFile) {
      options.tlsCAFile = tlsConfig.caFile;
    }
    if (tlsConfig.certFile) {
      options.tlsCertificateKeyFile = tlsConfig.certFile;
    }
  }

  const client = new MongoClient(mongoUrl, options);
  await client.connect();
  console.log('✅ MongoDB conectado com sucesso!');
  
  return { client, db: client.db(database) };
}

// Função para escrever certificados temporários
function writeCertFiles(tlsConfig) {
  if (!tlsConfig?.caCert && !tlsConfig?.clientCert) return null;
  
  const tempDir = '/tmp';
  let caFile = null;
  let certFile = null;
  
  try {
    if (tlsConfig.caCert) {
      caFile = path.join(tempDir, `ca_${Date.now()}_${Math.random().toString(36).substring(2)}.pem`);
      fs.writeFileSync(caFile, tlsConfig.caCert);
      console.log('📝 Certificado CA escrito:', caFile);
    }
    
    if (tlsConfig.clientCert) {
      certFile = path.join(tempDir, `cert_${Date.now()}_${Math.random().toString(36).substring(2)}.pem`);
      fs.writeFileSync(certFile, tlsConfig.clientCert);
      console.log('📝 Certificado cliente escrito:', certFile);
    }
  } catch (error) {
    console.error('❌ Erro ao escrever certificados:', error);
    throw error;
  }
  
  return { caFile, certFile };
}

// POST /connect - Estabelecer conexão
app.post('/connect', async (req, res) => {
  try {
    const { connectionId, mongoUrl, database, tlsConfig } = req.body;
    
    console.log('📥 Recebida requisição de conexão:', {
      connectionId,
      database,
      tlsEnabled: tlsConfig?.enabled || false,
      hasUrl: !!mongoUrl
    });
    
    if (!connectionId || !mongoUrl || !database) {
      return res.status(400).json({
        success: false,
        error: 'connectionId, mongoUrl e database são obrigatórios'
      });
    }

    console.log(`🚀 Conectando ${connectionId}...`);
    
    // Escrever certificados se fornecidos
    const certFiles = (tlsConfig?.enabled && (tlsConfig.caCert || tlsConfig.clientCert)) 
      ? writeCertFiles(tlsConfig) 
      : null;
    
    const config = {
      mongoUrl,
      database,
      tlsConfig: tlsConfig?.enabled ? {
        enabled: true,
        insecure: tlsConfig.insecure || false,
        caFile: certFiles?.caFile,
        certFile: certFiles?.certFile
      } : { enabled: false }
    };
    
    const connection = await createMongoConnection(config);
    activeConnections.set(connectionId, {
      ...connection,
      config,
      certFiles,
      createdAt: new Date()
    });
    
    // Testar com ping
    await connection.db.admin().ping();
    console.log('✅ Ping successful');
    
    res.json({
      success: true,
      message: tlsConfig?.enabled ? 'Conexão TLS estabelecida' : 'Conexão estabelecida',
      connectionId,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erro na conexão:', error);
    res.status(500).json({
      success: false,
      error: 'Falha na conexão MongoDB',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /query - Executar query
app.post('/query', async (req, res) => {
  try {
    const { connectionId, collection, operation, query, options } = req.body;
    
    if (!connectionId || !collection || !operation) {
      return res.status(400).json({
        success: false,
        error: 'connectionId, collection e operation são obrigatórios'
      });
    }
    
    const connection = activeConnections.get(connectionId);
    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Conexão não encontrada'
      });
    }
    
    console.log(`🔍 Executando ${operation} em ${collection}...`);
    
    const coll = connection.db.collection(collection);
    let result;
    
    switch (operation) {
      case 'find':
        result = await coll.find(query || {}, options).toArray();
        break;
      case 'findOne':
        result = await coll.findOne(query || {}, options);
        break;
      case 'insertOne':
        result = await coll.insertOne(query, options);
        break;
      case 'insertMany':
        result = await coll.insertMany(query, options);
        break;
      case 'updateOne':
        result = await coll.updateOne(query.filter, query.update, options);
        break;
      case 'updateMany':
        result = await coll.updateMany(query.filter, query.update, options);
        break;
      case 'deleteOne':
        result = await coll.deleteOne(query, options);
        break;
      case 'deleteMany':
        result = await coll.deleteMany(query, options);
        break;
      case 'countDocuments':
        result = await coll.countDocuments(query || {}, options);
        break;
      case 'aggregate':
        result = await coll.aggregate(query, options).toArray();
        break;
      default:
        throw new Error(`Operação não suportada: ${operation}`);
    }
    
    res.json({
      success: true,
      data: result,
      operation,
      collection,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erro na query:', error);
    res.status(500).json({
      success: false,
      error: 'Falha na execução da query',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// GET /collections/:connectionId - Listar collections
app.get('/collections/:connectionId', async (req, res) => {
  try {
    const { connectionId } = req.params;
    
    const connection = activeConnections.get(connectionId);
    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Conexão não encontrada'
      });
    }
    
    console.log('📋 Listando collections...');
    
    const collections = await connection.db.listCollections().toArray();
    const collectionsData = [];
    
    for (const collInfo of collections) {
      try {
        const coll = connection.db.collection(collInfo.name);
        const count = await coll.countDocuments();
        const stats = await connection.db.stats();
        
        collectionsData.push({
          name: collInfo.name,
          type: collInfo.type,
          documentCount: count,
          sizeBytes: stats.dataSize || 0,
          avgDocSize: count > 0 ? Math.round((stats.dataSize || 0) / count) : 0,
          indexes: []
        });
        
      } catch (collError) {
        console.log(`⚠️ Erro ao processar ${collInfo.name}:`, collError.message);
        collectionsData.push({
          name: collInfo.name,
          type: collInfo.type,
          documentCount: 0,
          sizeBytes: 0,
          avgDocSize: 0,
          indexes: [],
          error: collError.message
        });
      }
    }
    
    res.json({
      success: true,
      collections: collectionsData,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erro ao listar collections:', error);
    res.status(500).json({
      success: false,
      error: 'Falha ao listar collections',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// DELETE /disconnect/:connectionId - Desconectar
app.delete('/disconnect/:connectionId', async (req, res) => {
  try {
    const { connectionId } = req.params;
    
    const connection = activeConnections.get(connectionId);
    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Conexão não encontrada'
      });
    }
    
    console.log(`🔌 Desconectando ${connectionId}...`);
    
    // Fechar conexão MongoDB
    await connection.client.close();
    
    // Limpar arquivos de certificado
    if (connection.certFiles) {
      try {
        fs.unlinkSync(connection.certFiles.caFile);
        fs.unlinkSync(connection.certFiles.certFile);
        console.log('🧹 Certificados temporários removidos');
      } catch (cleanupError) {
        console.log('⚠️ Erro ao limpar certificados:', cleanupError.message);
      }
    }
    
    // Remover da lista de conexões ativas
    activeConnections.delete(connectionId);
    
    res.json({
      success: true,
      message: 'Conexão encerrada',
      connectionId,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erro ao desconectar:', error);
    res.status(500).json({
      success: false,
      error: 'Falha ao desconectar',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// GET /status - Status do serviço
app.get('/status', (req, res) => {
  res.json({
    success: true,
    service: 'MongoDB TLS Proxy',
    version: '1.0.0',
    activeConnections: activeConnections.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// GET /health - Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'mongodb-tls-proxy',
    timestamp: new Date().toISOString() 
  });
});

// Middleware de erro global
app.use((error, req, res, next) => {
  console.error('💥 Erro não tratado:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    details: error.message,
    timestamp: new Date().toISOString()
  });
});

// Handle 404s
app.use('*', (req, res) => {
  console.log('🔍 Rota não encontrada:', req.method, req.originalUrl);
  res.status(404).json({
    success: false,
    error: 'Route not found',
    method: req.method,
    url: req.originalUrl,
    availableRoutes: ['/', '/status', '/health', 'POST /connect', 'POST /query', 'GET /collections/:id', 'DELETE /disconnect/:id'],
    timestamp: new Date().toISOString()
  });
});

// Limpeza ao encerrar
process.on('SIGINT', async () => {
  console.log('🛑 Encerrando serviço...');
  
  for (const [connectionId, connection] of activeConnections) {
    try {
      await connection.client.close();
      if (connection.certFiles) {
        if (connection.certFiles.caFile && fs.existsSync(connection.certFiles.caFile)) {
          fs.unlinkSync(connection.certFiles.caFile);
        }
        if (connection.certFiles.certFile && fs.existsSync(connection.certFiles.certFile)) {
          fs.unlinkSync(connection.certFiles.certFile);
        }
      }
    } catch (error) {
      console.error(`Erro ao limpar conexão ${connectionId}:`, error);
    }
  }
  
  process.exit(0);
});

const server = app.listen(PORT, () => {
  console.log(`🚀 MongoDB TLS Proxy rodando na porta ${PORT}`);
  console.log(`📋 Status: http://localhost:${PORT}/status`);
  console.log(`❤️ Health: http://localhost:${PORT}/health`);
  console.log(`🌐 Root: http://localhost:${PORT}/`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM recebido, encerrando gracefully...');
  server.close(() => {
    console.log('✅ Servidor HTTP encerrado');
    process.exit(0);
  });
});

module.exports = app;

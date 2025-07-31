
const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Armazenar conexões ativas
const activeConnections = new Map();

console.log('🚀 MongoDB TLS Proxy Service iniciado');

// Root endpoint - MUITO IMPORTANTE para teste
app.get('/', (req, res) => {
  console.log('🏠 Root endpoint acessado');
  res.json({
    success: true,
    service: 'MongoDB TLS Proxy',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'mongodb-tls-proxy',
    timestamp: new Date().toISOString() 
  });
});

// Status endpoint
app.get('/status', (req, res) => {
  res.json({
    success: true,
    activeConnections: activeConnections.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// Função para criar conexão MongoDB com TLS
async function createMongoConnection(config) {
  const { mongoUrl, database, tlsConfig } = config;
  
  console.log('🔗 Criando conexão MongoDB TLS...');
  
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
  console.log('✅ MongoDB conectado!');
  
  return { client, db: client.db(database) };
}

// POST /connect
app.post('/connect', async (req, res) => {
  try {
    const { connectionId, mongoUrl, database, tlsConfig } = req.body;
    
    console.log('📥 Conexão solicitada:', { connectionId, database, tlsEnabled: tlsConfig?.enabled });
    
    if (!connectionId || !mongoUrl || !database) {
      return res.status(400).json({
        success: false,
        error: 'connectionId, mongoUrl e database são obrigatórios'
      });
    }

    // Escrever certificados se fornecidos
    let certFiles = null;
    if (tlsConfig?.enabled && (tlsConfig.caCert || tlsConfig.clientCert)) {
      const tempDir = '/tmp';
      
      if (tlsConfig.caCert) {
        const caFile = path.join(tempDir, `ca_${connectionId}.pem`);
        fs.writeFileSync(caFile, tlsConfig.caCert);
        certFiles = { caFile };
      }
      
      if (tlsConfig.clientCert) {
        const certFile = path.join(tempDir, `cert_${connectionId}.pem`);
        fs.writeFileSync(certFile, tlsConfig.clientCert);
        if (!certFiles) certFiles = {};
        certFiles.certFile = certFile;
      }
    }
    
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
    
    // Testar conexão
    await connection.db.admin().ping();
    
    res.json({
      success: true,
      message: 'Conexão estabelecida',
      connectionId,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erro na conexão:', error);
    res.status(500).json({
      success: false,
      error: 'Falha na conexão',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// POST /query
app.post('/query', async (req, res) => {
  try {
    const { connectionId, collection, operation, query, options } = req.body;
    
    const connection = activeConnections.get(connectionId);
    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'Conexão não encontrada'
      });
    }
    
    const coll = connection.db.collection(collection);
    let result;
    
    switch (operation) {
      case 'find':
        result = await coll.find(query || {}, options).toArray();
        break;
      case 'findOne':
        result = await coll.findOne(query || {}, options);
        break;
      case 'aggregate':
        result = await coll.aggregate(query, options).toArray();
        break;
      case 'countDocuments':
        result = await coll.countDocuments(query || {}, options);
        break;
      default:
        throw new Error(`Operação não suportada: ${operation}`);
    }
    
    res.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erro na query:', error);
    res.status(500).json({
      success: false,
      error: 'Falha na query',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// GET /collections/:connectionId
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
    
    const collections = await connection.db.listCollections().toArray();
    const collectionsData = [];
    
    for (const collInfo of collections) {
      try {
        const coll = connection.db.collection(collInfo.name);
        const count = await coll.countDocuments();
        
        collectionsData.push({
          name: collInfo.name,
          type: collInfo.type,
          documentCount: count,
          sizeBytes: 0,
          avgDocSize: 0
        });
        
      } catch (collError) {
        collectionsData.push({
          name: collInfo.name,
          type: collInfo.type,
          documentCount: 0,
          sizeBytes: 0,
          avgDocSize: 0,
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

// DELETE /disconnect/:connectionId
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
    
    await connection.client.close();
    
    // Limpar certificados
    if (connection.certFiles) {
      try {
        if (connection.certFiles.caFile) fs.unlinkSync(connection.certFiles.caFile);
        if (connection.certFiles.certFile) fs.unlinkSync(connection.certFiles.certFile);
      } catch (cleanupError) {
        console.log('⚠️ Erro ao limpar certificados:', cleanupError.message);
      }
    }
    
    activeConnections.delete(connectionId);
    
    res.json({
      success: true,
      message: 'Conexão encerrada',
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

// Handle 404s
app.use('*', (req, res) => {
  console.log('🔍 404:', req.method, req.originalUrl);
  res.status(404).json({
    success: false,
    error: 'Rota não encontrada',
    method: req.method,
    url: req.originalUrl,
    timestamp: new Date().toISOString()
  });
});

// Vercel precisa exportar o app
module.exports = app;

// Para desenvolvimento local
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
  });
}


const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));

// Armazenar conexões ativas
const activeConnections = new Map();

console.log('🚀 MongoDB Transparent Proxy Service iniciado');

// FUNÇÃO SIMPLIFICADA: Processar apenas ObjectId e ISODate
function processMongoValue(value) {
  if (typeof value === 'string') {
    // Processar ObjectId("...")
    const objectIdMatch = value.match(/^ObjectId\("([a-fA-F0-9]{24})"\)$/);
    if (objectIdMatch) {
      return new ObjectId(objectIdMatch[1]);
    }
    
    // Processar ISODate("...")
    const isoDateMatch = value.match(/^ISODate\("([^"]+)"\)$/);
    if (isoDateMatch) {
      return new Date(isoDateMatch[1]);
    }
    
    return value;
  } else if (Array.isArray(value)) {
    return value.map(item => processMongoValue(item));
  } else if (typeof value === 'object' && value !== null) {
    const processed = {};
    for (const [k, v] of Object.entries(value)) {
      processed[k] = processMongoValue(v);
    }
    return processed;
  }
  
  return value;
}

// FUNÇÃO TRANSPARENTE: Processar rawQuery sem alterar lógica
function parseRawQuery(rawQuery) {
  if (!rawQuery || typeof rawQuery !== 'string') {
    return {};
  }

  try {
    // Parse direto do JSON, processando apenas ObjectId e ISODate
    const parsed = JSON.parse(rawQuery);
    return processMongoValue(parsed);
  } catch (error) {
    console.error('❌ Erro ao fazer parse da rawQuery:', error);
    return {};
  }
}

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    service: 'MongoDB Transparent Proxy',
    version: '3.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    description: 'Pure communication layer - no business logic'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    service: 'mongodb-transparent-proxy',
    timestamp: new Date().toISOString() 
  });
});

// Status endpoint
app.get('/status', (req, res) => {
  res.status(200).json({
    success: true,
    activeConnections: activeConnections.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Função para criar conexão MongoDB com TLS
async function createMongoConnection(config) {
  const { mongoUrl, database, tlsConfig } = config;
  
  console.log('🔗 Criando conexão MongoDB...', { database, tlsEnabled: tlsConfig?.enabled });
  
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

// POST /connect
app.post('/connect', async (req, res) => {
  try {
    const { connectionId, mongoUrl, database, tlsConfig } = req.body;
    
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
    
    res.status(200).json({
      success: true,
      message: 'Conexão estabelecida com sucesso',
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

// POST /query - PROXY TRANSPARENTE
app.post('/query', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { connectionId, collection, operation, query, pipeline, filter, document, options, rawQuery } = req.body;
    
    console.log('🔍 ========== PROXY TRANSPARENTE ==========');
    console.log('ConnectionId:', connectionId);
    console.log('Collection:', collection);
    console.log('Operation:', operation);
    console.log('RawQuery:', rawQuery);
    console.log('Options:', options);
    
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

    const coll = connection.db.collection(collection);
    let result;
    
    // EXECUÇÃO TRANSPARENTE: Usar exatamente os parâmetros recebidos
    switch (operation) {
      case 'find':
        const findQuery = rawQuery ? parseRawQuery(rawQuery) : (query || filter || {});
        const findOptions = options || {};
        
        console.log('📋 EXECUTANDO FIND:');
        console.log('  Query:', JSON.stringify(findQuery, null, 2));
        console.log('  Options:', JSON.stringify(findOptions, null, 2));
        
        let cursor = coll.find(findQuery, findOptions);
        
        // Aplicar limit se especificado nas options
        if (findOptions.limit) {
          cursor = cursor.limit(findOptions.limit);
        }
        
        result = await cursor.toArray();
        
        console.log('✅ RESULTADO FIND:', result.length, 'documentos');
        break;
        
      case 'findOne':
        const findOneQuery = rawQuery ? parseRawQuery(rawQuery) : (query || filter || {});
        result = await coll.findOne(findOneQuery, options || {});
        break;
        
      case 'aggregate':
        let aggregatePipeline = pipeline || query || [];
        
        if (typeof aggregatePipeline === 'string') {
          aggregatePipeline = JSON.parse(aggregatePipeline);
        }
        
        // Processar pipeline para ObjectId/ISODate
        const processedPipeline = aggregatePipeline.map(stage => processMongoValue(stage));
        
        console.log('📋 EXECUTANDO AGGREGATE:');
        console.log('  Pipeline:', JSON.stringify(processedPipeline, null, 2));
        
        result = await coll.aggregate(processedPipeline, options || {}).toArray();
        
        console.log('✅ RESULTADO AGGREGATE:', result.length, 'documentos');
        break;
        
      case 'countDocuments':
        const countQuery = rawQuery ? parseRawQuery(rawQuery) : (query || filter || {});
        result = await coll.countDocuments(countQuery, options || {});
        break;
        
      case 'insertOne':
        result = await coll.insertOne(document || query, options || {});
        break;
        
      case 'insertMany':
        result = await coll.insertMany(document || query, options || {});
        break;
        
      case 'updateOne':
        result = await coll.updateOne(filter || query || {}, document, options || {});
        break;
        
      case 'updateMany':
        result = await coll.updateMany(filter || query || {}, document, options || {});
        break;
        
      case 'deleteOne':
        result = await coll.deleteOne(filter || query || {}, options || {});
        break;
        
      case 'deleteMany':
        result = await coll.deleteMany(filter || query || {}, options || {});
        break;
        
      default:
        throw new Error(`Operação não suportada: ${operation}`);
    }
    
    const executionTime = Date.now() - startTime;
    
    console.log('✅ QUERY EXECUTADA TRANSPARENTEMENTE');
    console.log('  Tempo:', executionTime + 'ms');
    console.log('  Resultado:', typeof result, Array.isArray(result) ? result.length + ' items' : 'single item');
    
    res.status(200).json({
      success: true,
      data: result,
      executionTime: executionTime,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    const executionTime = Date.now() - startTime;
    console.error('💥 ERRO NO PROXY TRANSPARENTE:', error);
    
    res.status(500).json({
      success: false,
      error: 'Falha na execução da query',
      details: error.message,
      executionTime: executionTime,
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
    
    res.status(200).json({
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
    
    res.status(200).json({
      success: true,
      message: 'Conexão encerrada com sucesso',
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
  res.status(404).json({
    success: false,
    error: 'Rota não encontrada',
    method: req.method,
    url: req.originalUrl,
    timestamp: new Date().toISOString()
  });
});

// Error handler
app.use((error, req, res, next) => {
  console.error('💥 Erro não tratado:', error);
  res.status(500).json({
    success: false,
    error: 'Erro interno do servidor',
    details: error.message,
    timestamp: new Date().toISOString()
  });
});

// Exportar para Vercel
module.exports = app;

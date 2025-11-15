require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3100;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const VERSIONS_FILE = path.join(DATA_DIR, 'versions.json');
const UPDATE_FILE = path.join(DATA_DIR, 'update.json');

// 中间件
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// 读取版本数据
async function loadVersions() {
  try {
    const data = await fs.readFile(VERSIONS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('❌ 读取版本数据失败:', error.message);
    return {
      tools: [],
      updated_at: null,
      status: 'error'
    };
  }
}

async function loadUpdateInfo() {
  try {
    const data = await fs.readFile(UPDATE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('❌ 读取更新数据失败:', error.message);
    return {
      version: null,
      update: {},
      release_notes: '',
      required: false,
      updated_at: null,
    };
  }
}

// 生成 ETag
function generateETag(data) {
  const content = JSON.stringify(data);
  return crypto.createHash('md5').update(content).digest('hex');
}

// API 路由

// GET /api/v1/tools - 获取所有工具版本
app.get('/api/v1/tools', async (req, res) => {
  try {
    const data = await loadVersions();
    const etag = generateETag(data);

    // 设置缓存头
    res.set({
      'Cache-Control': 'public, max-age=60',  // 60秒缓存，确保镜像状态及时更新
      'ETag': `"${etag}"`,
      'Vary': 'Accept-Encoding'
    });

    // 检查 If-None-Match 头（ETag 验证）
    if (req.headers['if-none-match'] === `"${etag}"`) {
      return res.status(304).end();  // Not Modified
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/tools/:id - 获取单个工具版本
app.get('/api/v1/tools/:id', async (req, res) => {
  try {
    const data = await loadVersions();
    const tool = data.tools.find(t => t.id === req.params.id);

    if (!tool) {
      return res.status(404).json({
        error: 'Tool not found',
        id: req.params.id
      });
    }

    res.json(tool);
  } catch (error) {
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/v1/update - 获取客户端更新信息
app.get('/api/v1/update', async (req, res) => {
  try {
    const data = await loadUpdateInfo();
    const etag = generateETag(data);

    res.set({
      'Cache-Control': 'public, max-age=300',
      'ETag': `"${etag}"`,
      'Vary': 'Accept-Encoding',
    });

    if (req.headers['if-none-match'] === `"${etag}"`) {
      return res.status(304).end();
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

// GET /api/v1/health - 健康检查
app.get('/api/v1/health', async (req, res) => {
  try {
    const data = await loadVersions();
    const now = new Date();
    const updatedAt = data.updated_at ? new Date(data.updated_at) : null;
    const isStale = updatedAt ? (now - updatedAt) > 15 * 60 * 1000 : true; // 15分钟

    // Per-tool 状态
    const toolsStatus = data.tools.map(tool => ({
      id: tool.id,
      name: tool.name,
      has_version: !!tool.latest_version,
      is_stale: tool.is_stale || tool.stale || false,  // 兼容旧字段 stale
      has_error: !!tool.error || !!tool.last_check_error,
      last_check_at: tool.last_check_at || tool.updated_at
    }));

    res.json({
      status: isStale ? 'stale' : (data.status || 'ok'),
      updated_at: data.updated_at,
      tools_count: data.tools.length,
      age_minutes: updatedAt ? Math.floor((now - updatedAt) / 60000) : null,
      tools: toolsStatus
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

// 404 处理
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path
  });
});

// 启动服务器
async function start() {
  // 确保数据目录存在
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    console.error('❌ 创建数据目录失败:', error.message);
  }

  // 启动 HTTP 服务
  app.listen(PORT, () => {
    console.log(`✅ Version API 服务已启动`);
    console.log(`   监听端口: ${PORT}`);
    console.log(`   数据目录: ${DATA_DIR}`);
    console.log(`   健康检查: http://localhost:${PORT}/api/v1/health`);
  });

  // 启动定时任务（每10分钟更新一次）
  if (process.env.ENABLE_CRON !== 'false') {
    const updateVersions = require('../scripts/update-versions');

    // 立即执行一次
    console.log('🔄 执行首次版本检查...');
    updateVersions().catch(err => {
      console.error('❌ 首次版本检查失败:', err.message);
    });

    // 每10分钟执行一次
    cron.schedule('*/10 * * * *', () => {
      console.log('🔄 定时版本检查开始...');
      updateVersions().catch(err => {
        console.error('❌ 定时版本检查失败:', err.message);
      });
    });

    console.log('⏰ 定时任务已启动 (每10分钟)');
  }
}

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('📴 收到 SIGTERM 信号，准备关闭...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n📴 收到 SIGINT 信号，准备关闭...');
  process.exit(0);
});

start();

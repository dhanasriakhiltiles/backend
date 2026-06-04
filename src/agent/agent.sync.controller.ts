import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Headers,
  Param,
  BadRequestException,
  UsePipes,
  ValidationPipe,
  UseGuards,
  Req
} from '@nestjs/common';
import * as crypto from 'crypto';
import { AgentService } from './agent.service';
import { RegisterAgentDto } from './dto/register-agent.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { ReceiveTallyDto } from './dto/receive-tally.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';

@Controller('agent/sync')
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 60, ttl: 60000 } })
@UsePipes(new ValidationPipe())
export class AgentSyncController {
  constructor(private readonly agentService: AgentService) {}

  /** Register new Agent (Protected) */
  @UseGuards(JwtAuthGuard)
  @Post('register')
  async register(@Body() body: RegisterAgentDto, @Req() req: any) {
    const { backendUrl, authToken, tallyPort, name } = body;
    
    // Ensure the agent is registered for the logged-in user
    const userid = req.user.userid || req.user.id;
    
    return this.agentService.registerAgent({
      backendUrl,
      authToken,
      tallyPort,
      name,
      userid,
    });
  }

  /** 🔹 Frontend/Agent triggers FETCH_TALLY task */
  @Get('fetch-tally')
  async createFetch(
    @Headers('authorization') authHeader: string,
    @Query() query: { companyName: string; port: string },
  ) {
    const { companyName, port } = query;
    
    if (!companyName || !port) {
      throw new BadRequestException('Missing required params: companyName, port');
    }

    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.split(' ')[1]
      : null;

    if (!token) {
      throw new BadRequestException('Missing or invalid Authorization header');
    }

    return this.agentService.createFetchTask({
      token,
      companyName,
      port: Number(port),
    } as CreateTaskDto);
  }

  /** 🔄 Agent polls backend for pending tasks */
  @Get('poll-tasks')
  async poll(@Headers('x-agent-token-hash') tokenHash: string) {
    if (!tokenHash) {
      throw new BadRequestException('x-agent-token-hash header required');
    }
    return this.agentService.pollTasks(tokenHash);
  }

  /** 📤 Agent sends processed Tally data back to backend */
  @Post('receive-tally')
  async receive(
    @Headers('x-agent-token-hash') tokenHash: string,
    @Headers('x-agent-signature') signature: string,
    @Body() body: any,
  ) {
    if (!tokenHash) {
      throw new BadRequestException('x-agent-token-hash header required');
    }
    return this.agentService.receiveTally(tokenHash, body, signature);
  }

  /** ✅ Additional endpoints for better UX */
  
  /** Get agent info by tokenHash */
  @Get('info')
  async getAgentInfo(@Headers('x-agent-token-hash') tokenHash: string) {
    if (!tokenHash) {
      throw new BadRequestException('x-agent-token-hash header required');
    }
    
    // ✅ CHANGE: Service method use karo directly agentModel access ke bajaye
    const agent = await this.agentService.getAgentByTokenHash(tokenHash);
    if (!agent) {
      throw new BadRequestException('Agent not found');
    }
    
    return {
      agentId: agent.agentId,
      name: agent.name,
      port: agent.port,
      userid: agent.userid,
      lastSeen: agent.lastSeen,
    };
  }

  /** Get user's agents */
  @Get('my-agents')
  async getUserAgents(@Query('userid') userid: string) {
    if (!userid) {
      throw new BadRequestException('userid required');
    }
    
    // ✅ CHANGE: Service method use karo
    const agents = await this.agentService.getUserAgents(userid);
    
    return { agents };
  }

  /** Bug 1 fix: Get task status by requestId — frontend polls this for real results */
  @Get('task-status/:requestId')
  async getTaskStatus(@Param('requestId') requestId: string) {
    if (!requestId) {
      throw new BadRequestException('requestId required');
    }
    return this.agentService.getTaskStatus(requestId);
  }

  /** Bug 2 fix: Real agent health check via lastSeen timestamp (uses userid from JWT, not agent tokenHash) */
  @Get('agent-health')
  async checkAgentHealth(@Headers('authorization') authHeader: string) {
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.split(' ')[1]
      : null;
    if (!token) {
      throw new BadRequestException('Missing or invalid Authorization header');
    }
    // Decode JWT to get userid — this is the admin user's ID, stable across login sessions
    let userid: string;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      userid = payload.userid || payload.id;
    } catch {
      throw new BadRequestException('Invalid JWT token');
    }
    if (!userid) {
      throw new BadRequestException('Could not extract userid from token');
    }
    return this.agentService.checkAgentHealth(userid);
  }
}
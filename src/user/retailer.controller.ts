import { Controller, Get, Headers, Put, UseGuards, Body, UnauthorizedException, NotFoundException, Post, Req, UseInterceptors, UploadedFile, BadRequestException, Query, Delete, Param, Patch } from "@nestjs/common";
import { User } from "./schemas/user.schema"
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { AdminService } from "./admin.service";
import { AuthGuard } from '@nestjs/passport';
import { Request } from "express";
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CategoryService } from './category.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { Retailerfield } from './schemas/retailerfields.schema';
import { Party } from "./schemas/party.schema";


@Controller('/retailer')
export class RetailerController {
    constructor(
        @InjectModel(User.name) private userModel: Model<User>,
        @InjectModel(Party.name) private partyModel: Model<Party>,
        private readonly categoryService: CategoryService,
    ) {}

@Get('/profile')  
@UseGuards(JwtAuthGuard)
async getProfile(@Req() req) {
    const user = await this.userModel.findOne({ userid: req.user.userid }).select('name userid email phonenumber city state zip subscription subscription_update adminid');
    const party = await this.partyModel.findOne({ userid: req.user.userid });
        if (party) {
            const store_name= party.store_name
            return { user, store_name };
        }
        return { user };
}

@Patch('/profile')
@UseGuards(JwtAuthGuard)
async updateProfile(@Req() req, @Body() body) {
    const user = await this.userModel.findOne({ userid: req.user.userid });
    if (!user) {
        throw new NotFoundException('User not found');
    }
    user.name = body.name;
    user.email = body.email;
    user.phonenumber = body.phonenumber;
    user.city = body.city;
    user.state = body.state;
    user.zip = body.zip;
    await user.save();

    const party = await this.partyModel.findOne({ userid: req.user.userid });
    if (party) {
        party.store_name = body.storename;
        await party.save();
    }
    return { user, party };
}


@Post('custom-categories')
@UseGuards(JwtAuthGuard)
async saveCustomCategories(@Req() req, @Body() body) {
  // body: { categories: [{ name: string, productIds: string[] }] }
  return this.categoryService.saveUserCategories(req.user.userid, body.categories);
}

@Get('custom-categories')
@UseGuards(JwtAuthGuard)
async getCustomCategories(@Req() req) {
  const retailer = await this.userModel.findOne({ userid: req.user.userid }).select('adminid');
  const adminId = retailer?.adminid || req.user.adminid;
  if (!adminId) {
    return [];
  }
  return this.categoryService.getUserCategories(adminId);
}

@Delete('custom-categories')
@UseGuards(JwtAuthGuard)
async deleteCustomCategories(@Req() req, @Body() body) {
  return this.categoryService.deleteUserCategories(req.user.userid, body.name);
}

}
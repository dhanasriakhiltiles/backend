import { Controller, Get, Headers, Put, UseGuards, Body, UnauthorizedException, NotFoundException, Post, Req, UseInterceptors, UploadedFile, BadRequestException, Query, Delete, Param, Patch } from "@nestjs/common";
import { User } from "./schemas/user.schema"
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { AdminService } from "./admin.service";
import { AuthGuard } from '@nestjs/passport';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CategoryService } from './category.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { Retailerfield } from './schemas/retailerfields.schema';
import { Party } from "./schemas/party.schema";
import { IsString, IsNotEmpty, IsObject } from 'class-validator'; // For DTO validation

export class TallySyncDto {
  @IsString()
  @IsNotEmpty()
  port: string;

  @IsString()
  @IsNotEmpty()
  companyName: string;

  @IsObject()
  fieldMapping: { [key: string]: string };
}
export type SyncResult = {
  success: boolean;
  message: string;
};


const storage = diskStorage({
  destination: (req, file, cb) => {
    const { type, device } = req.body;
    const dir = path.join(__dirname, `../../uploads/${type}s/${device}`);
    fs.mkdirSync(dir, { recursive: true }); // Ensures the directory exists
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname.replace(/\s/g, '')}`);
  },
});

@Controller('/admin')
export class AdminController {
    constructor(
        @InjectModel(User.name) private userModel: Model<User>,
        @InjectModel(Party.name) private partyModel: Model<Party>,
        private readonly adminService: AdminService,
        private readonly categoryService: CategoryService,
        @InjectModel(Retailerfield.name) private retailerfieldModel: Model<Retailerfield>,
    ) {}

    @Get('/profile')  
    @UseGuards(JwtAuthGuard)
    async getProfile(@Req() req) {
        const user = await this.userModel.findOne({ userid: req.user.userid }).select('name userid email phonenumber city state zip subscription subscription_update');
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


    @Get('/retailers')
    @UseGuards(JwtAuthGuard)
    async getAllRetailers(@Req() req): Promise<User[]> {
        const userid = req.user.userid;
        if (!userid) {
            throw new NotFoundException('Admin not found');
        }

        return this.userModel
        .find({ userid: { $regex: /^r\d+$/ }, adminid :userid })
        .select('userid name email phonenumber city status created_stamp') // only include these
        .exec();
    }

    @Put('toggle-retailer-status')
    @UseGuards(AuthGuard('jwt'))
    async toggleRetailerStatus(@Body() body: { userid: string; AdminId: string; newStatus: string }) {
        return this.adminService.toggleRetailerStatus(body.userid, body.AdminId, body.newStatus);
    }


    @Get('/analytics')
    async getAnalytics(@Headers('adminid') adminId: string): Promise<any> {
        return this.adminService.getAnalytics({ id: adminId });
  }

@Post('/tallysync')
@UseGuards(JwtAuthGuard)
async syncTallyProducts(
  @Req() req: any,
  @Body() tallySyncDto: TallySyncDto,
): Promise<SyncResult> {
  const userId = req.user.userid;
  if (!userId) throw new BadRequestException('User ID not found in token.');
  return this.adminService.syncTallyProducts(userId, tallySyncDto);
}


  @Get('get-companies')
  @UseGuards(AuthGuard('jwt')) // Protect the route
  async getCompanies(@Req() req: any) {
    // The AuthGuard attaches the user payload from the JWT to the request object.
    // We assume the payload contains the `userid`.
    const userId = req.user.userid;
    if (!userId) {
      throw new NotFoundException('User ID not found in token.');
    }

    // 1. Find the user in the database using their ID.
    // We use .lean() for a faster, read-only query since we don't need to save changes.
    const user = await this.userModel.findOne({ userid: userId }).lean().exec();

    if (!user) {
      throw new NotFoundException('User not found.');
    }

    // 2. Check if the user has any saved companies.
    // If the tallyCompanies array doesn't exist or is empty, return an empty array.
    if (!user.tallyCompanies || user.tallyCompanies.length === 0) {
      return { companies: [] };
    }

    // 3. Extract just the names from the array of company objects.
    // The frontend dropdown only needs the names, not the numbers.
    const companyNames = user.tallyCompanies.map(company => company.name);

    // 4. Return the list of names in the expected format.
    return { companies: companyNames };
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
    return this.categoryService.getUserCategories(req.user.userid);
  }

  @Delete('custom-categories')
  @UseGuards(JwtAuthGuard)
  async deleteCustomCategories(@Req() req, @Body() body) {
    return this.categoryService.deleteUserCategories(req.user.userid, body.name);
  }

 

  @Post('retailer-fields')
  @UseGuards(JwtAuthGuard)
  async saveRetailerFields(@Req() req, @Body() body) {
    // body: { fieldVisibility: { [retailerId]: { [field]: boolean|string|string[] } } }
    const { fieldVisibility } = body;
    if (!fieldVisibility || typeof fieldVisibility !== 'object') {
      throw new BadRequestException('Invalid fieldVisibility data');
    }
    const updates = Object.entries(fieldVisibility).map(async ([retailerId, fieldsObj]: [string, any]) => {
      const fields = Object.entries(fieldsObj)
        .filter(([field, checked]) => field !== 'tally_account' && (field === 'product_id' || checked === true))
        .map(([field]) => field);
      let tally_account = fieldsObj.tally_account;
      if (!tally_account || tally_account.length === 0) tally_account = ['all'];
      if (typeof tally_account === 'string') {
        if (tally_account === 'all') tally_account = ['all'];
        else tally_account = tally_account.split(',').map((s: string) => s.trim()).filter(Boolean);
      }
      await this.retailerfieldModel.findOneAndUpdate(
        { userid: retailerId },
        { $set: { fields, tally_account } },
        { upsert: true, new: true }
      );
    });
    await Promise.all(updates);
    return { success: true, message: 'Field visibility saved successfully!' };
  }

  @Get('retailer-fields/all')
  @UseGuards(JwtAuthGuard)
  async getAllRetailerFields(@Req() req) {
    // Return all retailer field visibilities for this admin
    // If you want to filter by admin, add a filter here
    return this.retailerfieldModel.find().select('userid fields tally_account -_id').lean();
  }

  @Post('/save-tally-mapping')
  @UseGuards(JwtAuthGuard)
  async saveTallyMapping(@Req() req, @Body() body: { fieldMapping: { [key: string]: string } }) {
    const userId = req.user.userid;
    return this.adminService.saveTallyMapping(userId, body.fieldMapping);
  }

  @Post('/save-company')
  @UseGuards(JwtAuthGuard)
  async saveCompany(@Req() req, @Body() body: { companyName: string }) {
    const userId =  req.user.userid;
    return this.adminService.saveCompany(userId, body.companyName);
  }

  @Get('/get-tally-mapping')
  @UseGuards(JwtAuthGuard)
  async getTallyMapping(@Req() req) {
    const userId =  req.user.userid 
    return this.adminService.getTallyMapping(userId);
  }

  @Put('Subscription')
  @UseGuards(AuthGuard('jwt'))
  async subscription(@Body() body: { userid: string; days: number; action: 'StartNew' | 'HandleDays'; handleDaysType?: 'increase' | 'decrease'; adminId: string }) {
    return this.adminService.updateRetailerSubscription(body.userid, body.days, body.action, body.adminId, body.handleDaysType);
  }

  


}
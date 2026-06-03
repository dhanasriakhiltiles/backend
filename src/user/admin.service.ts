import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UserSecurityGroup } from './schemas/user-security-group.schema';
import { User } from './schemas/user.schema';
import { Product } from 'src/product/schemas/product.schema';
import { UserService } from './user.service';
import axios, { isAxiosError } from 'axios';
import { parseStringPromise } from 'xml2js';
import { Inventory } from 'src/product/schemas/inventory.schema';
import { TallyCompany } from './schemas/user.schema';

/**
 * Top-level helper types (must be outside the class)
 */
type TallyStockItem = Record<string, any>;

interface SyncResult {
  success: boolean;
  message: string;
}
interface CounterDoc {
  _id: string;
  seq: number;
  createdAt?: Date;
}

interface InventoryDoc {
  product_id?: string;
  party_id: string;
  quantity: number;
  batch_no?: string;
  updated_at?: Date;
  [k: string]: any;
}

interface ProductDoc {
  product_id?: string;
  sku?: string;
  name?: string;
  base_unit?: string;
  price?: number;
  opening_balance?: number;
  opening_value?: number;
  party_id?: string;
  [k: string]: any;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectModel(UserSecurityGroup.name)
    private userSecurityGroupModel: Model<UserSecurityGroup>,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Product.name) private productModel: Model<Product>,
    @InjectModel(Inventory.name) private inventoryModel: Model<Inventory>,
    private readonly UserService: UserService,
  ) {}

  /* ----------------------- Company + Mapping ----------------------- */

  async saveCompany(userId: string, companyName: string) {
    const user = await this.userModel.findOne({ userid: userId });
    if (!user) throw new NotFoundException('User not found');

    if (!Array.isArray(user.tallyCompanies)) user.tallyCompanies = [];

    const companyExists = user.tallyCompanies.some(
      (c) => c.name === companyName,
    );
    if (companyExists) {
      throw new BadRequestException(
        `"${companyName}" Company already exists for this user`,
      );
    }

    const lastNumber = user.tallyCompanies.length
      ? Math.max(...user.tallyCompanies.map((c) => c.number))
      : 0;

    const newCompany: TallyCompany = {
      name: companyName,
      number: lastNumber + 1,
    };
    user.tallyCompanies.push(newCompany);

    await user.save();

    return {
      success: true,
      message: `Company "${companyName}" saved successfully`,
    };
  }

  async saveTallyMapping(
    userId: string,
    newfieldMapping: { [key: string]: string },
  ) {
    if (!newfieldMapping || Object.keys(newfieldMapping).length === 0) {
      throw new BadRequestException(
        'Field mapping is empty. Please provide at least one mapped field.',
      );
    }
    const user = await this.userModel.findOne({ userid: userId });
    if (!user)
      throw new NotFoundException('User not found. Please log in again.');

    const existingMapping = user.tallyFieldMapping || {};
    user.tallyFieldMapping = { ...existingMapping, ...newfieldMapping };
    await user.save();

    return { success: true, message: 'Field mapping saved successfully.' };
  }

  async getTallyMapping(userId: string) {
    const user = await this.userModel.findOne({ userid: userId });
    return { fieldMapping: user?.tallyFieldMapping || {} };
  }

  /* ----------------------- Helpers ----------------------- */

  private normalize(field: string): string {
    return field?.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  }

  private _cleanTallyString = (value: any): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
      const inner = value._ ?? value.NAME ?? value.AMOUNT ?? value.NUMBER ?? '';
      return String(inner).replace(/\u0004/g, '').trim();
    }
    return String(value).replace(/\u0004/g, '').trim();
  };

  /**
   * Extract SKU from a raw Tally stock item using the SAME priority as _processTallyItem.
   * Priority: PARTNO → NAME → GUID
   */
  private _extractSkuFromRawItem(item: any): string {
    // PARTNO
    let partNo = '';
    if (item.$?.PARTNO) partNo = this._cleanTallyString(item.$.PARTNO);
    if (!partNo) {
      const partNoObj = item.PARTNO || item.PARTNO_x0020_ || item.PARTNUMBER;
      if (partNoObj) partNo = this._cleanTallyString(partNoObj);
    }
    if (!partNo) {
      const aliasObj = item.ALIAS || item.ALIAS_x0020_;
      if (aliasObj) partNo = this._cleanTallyString(aliasObj);
    }

    // NAME
    let name = '';
    if (item.$?.NAME) name = this._cleanTallyString(item.$.NAME);
    if (!name) {
      const nameObj = item.NAME || item.MAILINGNAME;
      if (nameObj) name = this._cleanTallyString(nameObj);
    }

    // GUID
    let guid = '';
    if (item.$?.GUID) guid = this._cleanTallyString(item.$.GUID);
    if (!guid) {
      const guidObj = item.GUID || item.REMOTEID;
      if (guidObj) guid = this._cleanTallyString(guidObj);
    }

    return partNo || name || guid || '';
  }

  private _buildCompanyRequestXML(): string {
    return `
  <ENVELOPE>
    <HEADER>
      <VERSION>1</VERSION>
      <TALLYREQUEST>Export</TALLYREQUEST>
      <TYPE>Collection</TYPE>
      <ID>List of Companies</ID>
    </HEADER>
    <BODY>
      <DESC>
        <STATICVARIABLES>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        </STATICVARIABLES>
        <TDL>
          <TDLMESSAGE>
            <COLLECTION NAME="List of Companies">
              <TYPE>Company</TYPE>
              <FETCH>NAME, STARTINGFROM, ENDINGAT, MAILINGNAME, ADDRESS, STATENAME, COUNTRY, PINCODE, PHONE</FETCH>
            </COLLECTION>
          </TDLMESSAGE>
        </TDL>
      </DESC>
    </BODY>
  </ENVELOPE>
  `;
  }

  private _buildStockItemRequestXML(): string {
    // ✅ FIXED: Add date range so Tally computes real-time closing balance
    const now = new Date();
    const currentMonth = now.getMonth(); // 0-indexed (0=Jan, 3=Apr)
    const currentYear = now.getFullYear();
    // Financial year starts April 1st
    const fyStartYear = currentMonth >= 3 ? currentYear : currentYear - 1;
    const svFromDate = `${fyStartYear}0401`;
    const svToDate = `${currentYear}${String(currentMonth + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

    return `
  <ENVELOPE>
    <HEADER>
      <VERSION>1</VERSION>
      <TALLYREQUEST>Export</TALLYREQUEST>
      <TYPE>Collection</TYPE>
      <ID>TallySyncStockItemsCollection</ID>
    </HEADER>
    <BODY>
      <DESC>
        <STATICVARIABLES>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          <SVFROMDATE>${svFromDate}</SVFROMDATE>
          <SVTODATE>${svToDate}</SVTODATE>
        </STATICVARIABLES>
        <TDL>
          <TDLMESSAGE>
            <COLLECTION NAME="TallySyncStockItemsCollection" ISINITIALIZE="Yes">
              <TYPE>StockItem</TYPE>
              <NATIVEMETHOD>GUID</NATIVEMETHOD>
              <NATIVEMETHOD>NAME</NATIVEMETHOD>
              <NATIVEMETHOD>PARENT</NATIVEMETHOD>
              <NATIVEMETHOD>BASEUNITS</NATIVEMETHOD>
              <NATIVEMETHOD>OPENINGBALANCE</NATIVEMETHOD>
              <NATIVEMETHOD>OPENINGVALUE</NATIVEMETHOD>
              <NATIVEMETHOD>CLOSINGBALANCE</NATIVEMETHOD>
              <NATIVEMETHOD>CLOSINGVALUE</NATIVEMETHOD>
              <NATIVEMETHOD>CLOSINGRATE</NATIVEMETHOD>
              <NATIVEMETHOD>STANDARDCOST</NATIVEMETHOD>
              <NATIVEMETHOD>HSN</NATIVEMETHOD>
              <NATIVEMETHOD>GSTAPPLICABLE</NATIVEMETHOD>
              <NATIVEMETHOD>DESCRIPTION</NATIVEMETHOD>
              <NATIVEMETHOD>PARTNO</NATIVEMETHOD>
            </COLLECTION>
          </TDLMESSAGE>
        </TDL>
      </DESC>
    </BODY>
  </ENVELOPE>
  `;
  }

  /* ----------------------- Helper Methods (same as AgentService) ----------------------- */



  private _extractTallyValue(
    item: any,
    possibleKeys: string[],
  ): string | undefined {
    if (!item || typeof item !== 'object') return undefined;

    const itemKeys = Object.keys(item);
    for (const k of possibleKeys) {
      if (!k) continue;

      // 1. Direct match (Case-Insensitive)
      const exactKey = itemKeys.find(key => key.toUpperCase() === k.toUpperCase());
      if (exactKey !== undefined && item[exactKey] !== undefined) {
         const val = this._cleanTallyString(item[exactKey]);
         if (val) return val;
      }

      // 2. Attribute match ($: { KEY: ... })
      if (item.$) {
        const attrKeys = Object.keys(item.$);
        const attrKey = attrKeys.find(key => key.toUpperCase() === k.toUpperCase());
        if (attrKey !== undefined) {
           const val = this._cleanTallyString(item.$[attrKey]);
           if (val) return val;
        }
      }

      // 3. Deep List match (e.g. MAILINGNAME.LIST, GSTDETAILS.LIST)
      const listKey = itemKeys.find(key => key.toUpperCase().includes(k.toUpperCase()) && key.toUpperCase().includes('.LIST'));
      if (listKey) {
          const list = Array.isArray(item[listKey]) ? item[listKey] : [item[listKey]];
          for (const entry of list) {
              const val = this._extractTallyValue(entry, [k, 'NAME', 'HSNCODE', 'GSTRATE', 'TAXABILITY']);
              if (val) return val;
          }
      }
    }
    return undefined;
  }

  /* ----------------------- Mapper ----------------------- */
  private _processTallyItem(
    tallyItem: TallyStockItem,
    context: { party_id: string; fieldMapping: Record<string, string> },
  ) {
    const { party_id, fieldMapping } = context;
    const item = tallyItem;

    // 1. GUID & Name & SKU
    const guid = this._extractTallyValue(item, ['GUID', 'REMOTEID']);
    const name = this._extractTallyValue(item, ['NAME', 'MAILINGNAME']);
    const partNo = this._extractTallyValue(item, ['PARTNO', 'MAILINGNAME', 'ALIAS']);
    
    // Priority: PartNo -> Name -> GUID (Readable SKUs)
    const sku = partNo || name || guid;

    if (!sku) return null;

    // 2. Core Stats
    const baseUnit = this._extractTallyValue(item, ['BASEUNITS', 'UOM', 'UNIT']);
    const openingBalanceRaw = this._extractTallyValue(item, [
      'CLOSINGBALANCE',
      'OPENINGBALANCE',
      'ACTUALQTY',
      'STOCKITEMOFF.LIST.OPENINGBALANCE'
    ]);
    const openingBalance = openingBalanceRaw
      ? parseFloat((openingBalanceRaw.match(/[-?\d.]+/) || ['0'])[0])
      : 0;

    const openingValueRaw = this._extractTallyValue(item, [
      'CLOSINGVALUE',
      'OPENINGVALUE',
      'STANDARDCOST',
    ]);
    const openingValue = Math.abs(parseFloat(String(openingValueRaw || '0').replace(/[^0-9.-]+/g, '')) || 0);

    const priceRaw = this._extractTallyValue(item, [
      'RATE',
      'PRICE',
      'STANDARDPRICE',
      'STANDARDCOST',
      'OPENINGRATE',
      'CLOSINGRATE'
    ]);
    const price = Math.abs(parseFloat(String(priceRaw || '0').replace(/[^0-9.-]+/g, '')) || 0);

    // 3. Hierarchy
    const parentRaw = this._extractTallyValue(item, ['PARENT', 'CATEGORY']);
    const parent = parentRaw ? this._cleanTallyString(parentRaw) : 'Uncategorized';
    const brand = parent !== 'Uncategorized' ? parent : 'Generic';

    const hsn = this._extractTallyValue(item, ['HSNCODE', 'HSN', 'TEMPGSTHSNCODE', 'GSTHSNCODE', 'HSNDETAILS.LIST.HSNCODE', 'GSTDETAILS.LIST.HSNCODE']);
    const gst = this._extractTallyValue(item, ['GSTAPPLICABLE', 'GSTEXEMPTIONTYPE', 'TAXABILITY', 'GSTDETAILS.LIST.TAXABILITY']);
    const description = this._extractTallyValue(item, ['DESCRIPTION', 'MAILINGNAME', 'DESC', 'LANGUAGENAME.LIST']);

    const attributes: Record<string, any> = {
      hsn, gst, guid, parent_group: parent, base_unit: baseUnit
    };

    // 4. Dynamic Attribute Catch-all
    for (const key of Object.keys(item)) {
       if (key === '$' || key.length < 2) continue;
       const val = this._extractTallyValue(item, [key]);
       if (val && typeof val === 'string' && val.length > 0 && val.length < 500) {
         attributes[key] = val;
       }
    }

    const product: ProductDoc = {
      sku: sku,
      name: name || sku,
      base_unit: baseUnit,
      price: price || (openingBalance !== 0 ? Math.round(openingValue / Math.abs(openingBalance)) : 0),
      opening_balance: openingBalance,
      opening_value: openingValue,
      party_id,
      parent,
      category: parent,
      brand: brand,
      hsn,
      gst,
      attributes,
      short_description: description,
    };

    // 5. User-defined Field Mapping
    if (fieldMapping && Object.keys(fieldMapping).length > 0) {
      for (const [tallyKey, appKey] of Object.entries(fieldMapping)) {
        const extractedValue = this._extractTallyValue(item, [tallyKey]);
        if (extractedValue !== undefined && extractedValue !== '') {
           const coreProductFields = ['name', 'sku', 'brand', 'category', 'subcategory', 'short_description', 'long_description', 'specification', 'price', 'base_unit', 'hsn', 'gst'];
           if (coreProductFields.includes(appKey)) {
              if (appKey === 'price') {
                 product[appKey] = Math.abs(parseFloat(extractedValue.replace(/[^0-9.-]+/g, '')) || 0);
              } else {
                 product[appKey] = extractedValue;
              }
           } else {
              attributes[appKey] = extractedValue;
           }
        }
      }
    }

    const inventories: InventoryDoc[] = [
      {
        party_id,
        quantity: openingBalance,
        batch_no: 'default',
        updated_at: new Date(),
      },
    ];

    return { product, inventories };
  }

  /* ----------------------- Product ID Counter (Safe) ----------------------- */
private async _peekNextProductId(): Promise<string> {
  const counters = this.productModel.db.collection<CounterDoc>('counters');
  let doc = await counters.findOne({ _id: 'productid' } as any);

  if (!doc?.seq) {
    // Initialize counter if missing
    await counters.updateOne(
      { _id: 'productid' } as any,
      { $set: { seq: 1000, createdAt: new Date() } },
      { upsert: true },
    );
    doc = await counters.findOne({ _id: 'productid' } as any);
  }

  return `PRD${doc!.seq}`;
}

private async _incrementProductId(): Promise<void> {
  const counters = this.productModel.db.collection<CounterDoc>('counters');
  await counters.updateOne(
    { _id: 'productid' } as any,
    { $inc: { seq: 1 } },
    { upsert: true },
  );
}

/* ----------------------- Main Sync ----------------------- */
async syncTallyProducts(
  userId: string,
  dto: { port: string; companyName: string; fieldMapping: { [k: string]: string } },
): Promise<SyncResult> {
  const { port, companyName: expectedCompanyName, fieldMapping: requestMapping } = dto;

  const user = await this.userModel.findOne({ userid: userId }).lean().exec();
  if (!user) throw new NotFoundException('User not found.');

  const party_id = await this.UserService.findpartyidbyuserid(userId);
  const finalMapping = { ...user.tallyFieldMapping, ...requestMapping };
  const tallyUrl = `http://localhost:${port}`;

  // Validate company
  this.logger.log(`Step 1/2: Validating company for user ${userId} on port ${port}`);
  try {
    const companyRequestXML = this._buildCompanyRequestXML();
    const companyResponse = await axios.post(tallyUrl, companyRequestXML, { timeout: 15000 });
    const companyResult = await parseStringPromise(companyResponse.data, { explicitArray: false, trim: true });
    
    // Support Collection format (Old) or direct Export format (New)
    let companyFromTally = '';
    const collectionData = companyResult?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY;
    if (collectionData) {
        companyFromTally = this._cleanTallyString(collectionData.$?.NAME || collectionData.NAME);
    }

    if (!companyFromTally) {
        // Try other paths common in Tally XML
        companyFromTally = this._cleanTallyString(companyResult?.ENVELOPE?.BODY?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE?.COMPANY?.$?.NAME);
    }

    if (!companyFromTally) throw new BadRequestException('Could not identify active company from Tally.');
    if (companyFromTally.toLowerCase() !== this._cleanTallyString(expectedCompanyName).toLowerCase())
      throw new BadRequestException(`Company Mismatch. Expected "${expectedCompanyName}" but Tally is active with "${companyFromTally}".`);

    this.logger.log(`Company validation successful. Found "${companyFromTally}".`);
  } catch (err) {
    if (err instanceof BadRequestException) throw err;
    if (axios.isAxiosError(err)) throw new BadRequestException(`Could not connect to Tally on port ${port} to verify company.`);
    throw err;
  }

  // Fetch stock items
  this.logger.log(`Step 2/2: Fetching product data for user ${userId}`);
  const stockItemRequestXML = this._buildStockItemRequestXML();
  const stockItemResponse = await axios.post(tallyUrl, stockItemRequestXML, { timeout: 60000 });
  const stockItemResult = await parseStringPromise(stockItemResponse.data, { explicitArray: false, trim: true });
  
  // Robust Collection extraction
  let stockItemsToProcess: TallyStockItem[] = [];
  const collection = stockItemResult?.ENVELOPE?.BODY?.DATA?.COLLECTION;
  if (collection?.STOCKITEM) {
      stockItemsToProcess = Array.isArray(collection.STOCKITEM) ? collection.STOCKITEM : [collection.STOCKITEM];
  }

  if (stockItemsToProcess.length === 0) {
     // Try REQUESTDATA path if using Export Data instead of Collection
     const requestData = stockItemResult?.ENVELOPE?.BODY?.IMPORTDATA?.REQUESTDATA;
     if (requestData?.TALLYMESSAGE) {
        const msgs = Array.isArray(requestData.TALLYMESSAGE) ? requestData.TALLYMESSAGE : [requestData.TALLYMESSAGE];
        for (const msg of msgs) {
           if (msg.STOCKITEM) stockItemsToProcess.push(msg.STOCKITEM);
        }
     }
  }

  if (stockItemsToProcess.length === 0)
    return { success: true, message: 'Sync complete: Company validated, but no stock items found.' };

  // ✅ FIX: Use the SAME SKU extraction logic as _processTallyItem (PARTNO → NAME → GUID)
  const allSkus = stockItemsToProcess
    .map((si) => this._extractSkuFromRawItem(si))
    .filter(Boolean);

  //Fetch existing products from DB
  const existingProducts = await this.productModel.find({ sku: { $in: allSkus }, party_id }).select('sku product_id').lean();
  const skuToProductIdMap = new Map(existingProducts.map((p: any) => [p.sku, p.product_id]));

  // Process stock items
  for (const tallyItem of stockItemsToProcess) {
    try {
      const processed = this._processTallyItem(tallyItem, { party_id, fieldMapping: finalMapping });
      if (!processed) continue;

      const { product, inventories } = processed;

      let productId = skuToProductIdMap.get(product.sku);
      if (!productId) {
        productId = await this._peekNextProductId();
        product.product_id = productId;

        // ✅ FIX: Use $set (not $setOnInsert) so that even if the SKU lookup
        // missed an existing product (edge case), it still gets updated with
        // the latest data from Tally.
        const inserted = await this.productModel.updateOne(
          { sku: product.sku, party_id },
          { $set: { ...product, tally_account: {} } },
          { upsert: true },
        );

        if (inserted.upsertedCount > 0) await this._incrementProductId();
        skuToProductIdMap.set(product.sku, productId);
      } else {
        product.product_id = productId;
        // ✅ Update ALL fields (price, stock, name, etc.) for existing product
        await this.productModel.updateOne(
          { sku: product.sku, party_id },
          { $set: { ...product, tally_account: {} } }
        );
      }

      for (const inv of inventories) {
        const invDoc: InventoryDoc = { ...inv, product_id: product.product_id, party_id };
        await this.inventoryModel.updateOne(
          { product_id: invDoc.product_id, party_id: invDoc.party_id },
          { $set: invDoc },
          { upsert: true },
        );
      }
    } catch (err: any) {
      this.logger.warn(`Skipping item due to processing error: ${err?.message || err}`, { item: tallyItem });
    }
  }

  return { success: true, message: `Sync completed successfully. Processed ${stockItemsToProcess.length} items.` };
}

  async createPreApprovedRetailer(data: {
    email: string;
    id: string;
    subscription: number;
  }): Promise<User> {
    const latestUser = await this.userModel
      .find({ userid: { $regex: /^r\d+$/ } })
      .sort({ userid: -1 })
      .limit(1)
      .exec();

    let nextIdNumber = 101;
    if (latestUser.length > 0) {
      const lastId = parseInt(latestUser[0].userid.slice(1));
      if (!isNaN(lastId)) nextIdNumber = lastId + 1;
    }

    const userid = `r${nextIdNumber}`;
    const user = await this.userModel.findById(data.id); // MongoDB _id
    if (!user) throw new NotFoundException('User not found');
    const adminid = user.userid;

    const newEntry = new this.userModel({
      email: data.email,
      created_stamp: new Date(),
      subscription_update: new Date(),
      userid,
      adminid,
      status: 'preapproved',
      subscription: data.subscription,
    });

    return newEntry.save();
  }

  async toggleRetailerStatus(
    UserId: string,
    AdminId: string,
    newStatus: string,
  ): Promise<{ message: string }> {
    const Admin = await this.userModel.findById(AdminId);
    if (!Admin || !Admin.userid.startsWith('a')) {
      throw new UnauthorizedException('Only Admins can toggle admin status');
    }

    const retailer = await this.userModel.findOne({ userid: UserId });
    if (!retailer) throw new NotFoundException('Admin not found');

    if (newStatus === 'active' && !retailer.phonenumber) {
      retailer.status = 'preapproved';
      newStatus = 'preapproved';
    } else {
      retailer.status = newStatus;
    }
    await retailer.save();

    return { message: `Status updated to ${newStatus}` };
  }

  async getAnalytics(data: { id: string }): Promise<any> {
    const user = await this.userModel.findById(data.id);
    if (!user) throw new NotFoundException('User not found');
    const adminid = user.userid;
    const partyid = await this.UserService.findpartyidbyuserid(adminid);

    const allretailer = await this.userModel
      .find({ userid: { $regex: /^r/ }, adminid })
      .select(
        'name city state zip lastlogin userid created_stamp status subscription subscription_update',
      );

    const products = await this.productModel.countDocuments({
      party_id: partyid,
    });

    const activereatailerCount = await this.userModel.countDocuments({
      userid: { $regex: /^r/ },
      status: 'active',
      adminid,
    });

    return { allretailer, products, activereatailerCount };
  }

  async updateRetailerSubscription(
    userid: string,
    days: number,
    action: 'StartNew' | 'HandleDays',
    adminId: string,
    handleDaysType?: 'increase' | 'decrease',
  ): Promise<{ message: string; newSubscription: number }> {
    const Admin = await this.userModel.findById(adminId);
    if (!Admin || !Admin.userid.startsWith('a')) {
      throw new UnauthorizedException('Only Admins can update subscription');
    }
    const admin = await this.userModel.findOne({ userid });
    if (!admin) {
      throw new NotFoundException('Admin not found');
    }
    if (userid === adminId) {
      throw new BadRequestException('You cannot modify your own subscription');
    }
    if (action === 'StartNew') {
      admin.subscription = days;
      admin.subscription_update = new Date();
    } else if (action === 'HandleDays') {
      if (handleDaysType === 'increase') {
        admin.subscription = (admin.subscription || 0) + days;
      } else if (handleDaysType === 'decrease') {
        admin.subscription = Math.max(0, (admin.subscription || 0) - days);
      }
    }
    await admin.save();
    return {
      message: `Subscription updated`,
      newSubscription: admin.subscription,
    };
  }
}

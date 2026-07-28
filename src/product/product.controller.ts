import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Req,
  UnauthorizedException,
  UploadedFiles,
  Delete,
  Param,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ProductService } from './product.service';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { Express } from 'express';
import * as jwt from 'jsonwebtoken';
import { getProductSchemaStructure } from './product.utils';
import { getInventorySchemaStructure } from './inventory.utils';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CloudinaryService } from '../cloudinary/cloudinary.service';

interface JwtPayload {
  sub: string;
  // add other properties you expect in the token
}

@Controller('product')
export class ProductController {
  constructor(
    private readonly productService: ProductService,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  @Post('add-product')
  @UseGuards(AuthGuard('jwt'))
  async addproduct(@Body() data: any) {
    return this.productService.addproduct(data);
  }

  @Post('add-inventory')
  @UseGuards(AuthGuard('jwt'))
  async addinventory(@Body() data: any) {
    return this.productService.addinventory(data);
  }

  @Post('bulk-import')
  @UseGuards(AuthGuard('jwt'))
  async bulkImportProducts(@Body() data: any, @Req() req) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) throw new UnauthorizedException('Token not found');

    const decoded = jwt.decode(token) as JwtPayload;
    if (!decoded) throw new UnauthorizedException('Invalid token');

    const docId = String(decoded.sub);

    return this.productService.bulkImportProducts(data.products, docId);
  }

  @Post('upload-images')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FilesInterceptor('images', 10))
  async uploadImages(
    @Req() req,
    @UploadedFiles() files: Array<Express.Multer.File>,
    @Body() body: any,
  ) {
    try {
      const productId = body.product_id;
      const uploadedUrls: string[] = [];

      if (!files || files.length === 0) {
        throw new BadRequestException('No files uploaded');
      }

      // Upload each file to Cloudinary
      for (const file of files) {
        const result = await this.cloudinaryService.uploadImage(
          file,
          'products',
        );
        uploadedUrls.push(result.secure_url);
      }

      // Update product with new images
      if (productId && uploadedUrls.length > 0) {
        const currentProduct = await this.productService.getProductById(productId);
        const currentImages = currentProduct?.images || [];
        const updatedImages = [
          ...currentImages,
          ...uploadedUrls,
        ];

        await this.productService.updateProduct(productId, {
          images: updatedImages,
        });
      }

      return {
        success: true,
        images: uploadedUrls,
        message: `Successfully uploaded ${uploadedUrls.length} images`,
      };
    } catch (error) {
      console.error('Image upload error:', error);
      throw new Error('Failed to upload images');
    }
  }

  @Post('upload-single-image')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('image'))
  async uploadSingleImage(
    @Req() req,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
  ) {
    try {
      const productId = body.product_id;

      if (!file) {
        throw new BadRequestException('No file uploaded');
      }

      const result = await this.cloudinaryService.uploadImage(file, 'products');

      // Update product with new image
      if (productId) {
        const currentProduct = await this.productService.getProductById(productId);
        const currentImages = currentProduct?.images || [];
        const updatedImages = [
          ...currentImages,
          result.secure_url,
        ];

        await this.productService.updateProduct(productId, {
          images: updatedImages,
        });
      }

      return {
        success: true,
        imageUrl: result.secure_url,
        publicId: result.public_id,
        message: 'Image uploaded successfully',
      };
    } catch (error) {
      console.error('Single image upload error:', error);
      throw new Error('Failed to upload image');
    }
  }

  @Delete('delete-image/:productId')
  @UseGuards(JwtAuthGuard)
  async deleteImage(@Param('productId') productId: string, @Body() body: any) {
    try {
      const { imageUrl, imageIndex } = body;

      if (!imageUrl) {
        throw new BadRequestException('Image URL is required');
      }

      // Extract public ID from Cloudinary URL
      const publicId = this.extractPublicIdFromUrl(imageUrl);

      // Delete from Cloudinary
      if (publicId) {
        await this.cloudinaryService.deleteImage(publicId);
      }

      // Remove from product images array
      const currentProduct = await this.productService.getProductById(productId);
      
      if (!currentProduct) {
        throw new BadRequestException('Product not found');
      }

      const currentImages = currentProduct.images || [];
      const updatedImages = currentImages.filter(
        (_: string, index: number) => index !== imageIndex,
      );

      await this.productService.updateProduct(productId, {
        images: updatedImages,
      });

      return {
        success: true,
        message: 'Image deleted successfully',
      };
    } catch (error) {
      console.error('Image deletion error:', error);
      throw new Error('Failed to delete image');
    }
  }

  private extractPublicIdFromUrl(url: string): string | null {
    try {
      if (!url) return null;
      
      // Extract public ID from Cloudinary URL
      const matches = url.match(/upload\/(?:v\d+\/)?(.+)\./);
      return matches ? matches[1] : null;
    } catch {
      return null;
    }
  }

  @Get('all')
  async getAdminProducts(@Req() req) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) throw new UnauthorizedException('Token not found');

    const decoded = jwt.decode(token) as JwtPayload;
    if (!decoded) throw new UnauthorizedException('Invalid token');

    const docId = decoded.sub;

    return this.productService.getAdminProducts(docId);
  }

  @Get('all-retailer')
  async getRetailerProducts(@Req() req) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) throw new UnauthorizedException('Token not found');

    const decoded = jwt.decode(token) as JwtPayload;
    if (!decoded) throw new UnauthorizedException('Invalid token');

    const docId = decoded.sub;

    return this.productService.getRetailerProducts(docId);
  }

  @Get('schema')
  getSchemaStructure() {
    return {
      product: getProductSchemaStructure(),
      inventory: getInventorySchemaStructure(),
    };
  }

  @Post('update/:product_id')
  @UseGuards(AuthGuard('jwt'))
  async updateProduct(@Param('product_id') productId: string, @Body() changes: any) {
    return this.productService.updateProduct(productId, changes);
  }

  @Delete('delete/:productId')
@UseGuards(JwtAuthGuard)
async deleteProduct(@Param('productId') productId: string) {
  try {
    // First, get the product to check if it exists and get its images
    const product = await this.productService.getProductById(productId);
    
    if (!product) {
      throw new NotFoundException('Product not found');
    }

    // Delete all associated images from Cloudinary
    if (product.images && product.images.length > 0) {
      for (const imageUrl of product.images) {
        const publicId = this.extractPublicIdFromUrl(imageUrl);
        if (publicId) {
          try {
            await this.cloudinaryService.deleteImage(publicId);
          } catch (cloudinaryError) {
            console.warn(`Failed to delete image from Cloudinary: ${publicId}`, cloudinaryError);
            // Continue with deletion even if image deletion fails
          }
        }
      }
    }

    // Delete the product from database
    await this.productService.deleteProduct(productId);

    return {
      success: true,
      message: 'Product deleted successfully',
    };
  } catch (error) {
    console.error('Product deletion error:', error);
    if (error instanceof NotFoundException) {
      throw error;
    }
    throw new Error('Failed to delete product');
  }
}
}
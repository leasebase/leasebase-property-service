# LeaseBase property-service

Property and unit management — listings, amenities, availability.

## Stack

- **Runtime**: Node.js / NestJS (planned)
- **Container**: Docker -> ECS Fargate
- **Registry**: ECR `leasebase-{env}-v2-property-service`
- **Port**: 3000

## Infrastructure

Managed by Terraform in [leasebase-iac](https://github.com/motart/leasebase-iac).

## Getting Started

```bash
npm install
npm run start:dev
docker build -t leasebase-property-service .
npm test
```

FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm install

# Source files are mounted via volume at runtime
CMD ["npm", "run", "watch"]

FROM --platform=linux/amd64 ubuntu:jammy

# Install Node.js, Docker and dependencies
RUN apt-get update -qq && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    jq \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    software-properties-common \
    dnsutils && \
    # Install Docker
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo \
    "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
    tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    # Install NodeJS
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get update -qq && \
    apt-get install -y --no-install-recommends \
    docker.io \
    nodejs && \
    # Clean up
    apt-get clean && \
    apt-get autoremove -y && \
    rm -rf \
    /var/lib/apt/lists/* \
    /tmp/* \
    /var/tmp/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY autoscaler.js .

# Set execute permissions
RUN chmod a+x autoscaler.js

CMD ["node", "autoscaler.js"]